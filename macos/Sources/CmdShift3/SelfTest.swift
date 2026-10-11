import AppKit

/// Headless end-to-end check of the client against a running server, without
/// the screenshot UI. Used for acceptance by the lead:
///
///   CmdShift3 --selftest [--endpoint URL] [--code may-demo] [--project ID] [--image file.png]
///
/// Signs in, drafts, commits (and retries the same id to check idempotency),
/// then reads feed / state / catch-up. Exit code 0 = pass.
@MainActor
enum SelfTest {
    static func arg(_ name: String) -> String? {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
        return a[i + 1]
    }

    static func run() async {
        // Never default to the public service: a selftest writes real commits.
        let endpoint = arg("--endpoint") ?? AppState.localEndpoint
        let client = APIClient(baseURL: URL(string: endpoint)!, token: nil)
        func log(_ s: String) { print(s); fflush(stdout) }
        if let failure = modelChecks() {
            log("FAIL: model check — \(failure)")
            exit(1)
        }
        if let path = arg("--progress-fixture") {
            // Dev parity check with web/app.js: prints the tree as JSON for a fixture
            // {"project_id", "current_user_id", "members":[...], "commits":[...]}.
            dumpProgress(path)
            exit(0)
        }
        log("✓ model checks (AI status labels, AI-first review gating, generation/revision guards, failure/frozen, close guard, preview)")
        if CommandLine.arguments.contains("--offline") { log("PASS (offline)"); exit(0) }
        do {
            let session = try await client.session(code: arg("--code") ?? "may-demo")
            client.token = session.token
            let project = arg("--project") ?? session.projects.first!.id
            log("✓ session: \(session.user.name), projects: \(session.projects.map(\.id))")

            let png = try arg("--image").map { try Data(contentsOf: URL(fileURLWithPath: $0)) } ?? samplePNG()
            let source = Source(appName: "CmdShift3 selftest", windowTitle: "selftest", captureKind: "upload")
            let comment = "Selftest: client upload works. Next: wire the demo."
            let draft = try await client.draft(DraftRequest(projectId: project, comment: comment, source: source,
                                                            imageBase64: png.base64EncodedString()))
            log("✓ draft: provider=\(draft.organizer?.provider ?? "?") summary=\(draft.summary ?? "")")

            // Commit 1 opens a blocker that belongs to this run; commit 2 resolves
            // exactly that one. Existing project blockers are never touched.
            let runTag = String(UUID().uuidString.prefix(8))
            var fields = Fields()
            fields.shipped = [.new("Client upload works (\(runTag))")]
            fields.blocker = [.new("Selftest blocker \(runTag)")]
            let ownBlocker = fields.blocker[0].id
            let annotations = [Annotation(type: .rect, x: 0.1, y: 0.1, w: 0.5, h: 0.3, text: nil, color: "#F97066"),
                               Annotation(type: .arrow, x: 0.8, y: 0.8, w: -0.2, h: -0.3, text: nil, color: "#2E90FA"),
                               Annotation(type: .text, x: 0.1, y: 0.5, w: 0, h: 0, text: "selftest", color: "#32D583")]
            let req = CommitRequest(id: "wc_" + UUID().uuidString.lowercased(), projectId: project, source: source,
                                    imageBase64: png.base64EncodedString(), annotations: annotations,
                                    comment: comment, summary: "Selftest \(runTag): upload works, blocker opened",
                                    fields: fields.cleaned())
            let c = try await client.commit(req)
            log("✓ commit 1: \(c.id) #\(c.sequence ?? -1) sha=\(c.git?.sha ?? "nil") synced=\(c.git?.remoteSynced.map(String.init) ?? "nil")")
            let again = try await client.commit(req)
            guard again.git?.sha == c.git?.sha else { throw APIError(status: 0, code: "idempotency", message: "retry produced a different SHA") }
            log("✓ retry with same id returned same commit")
            let open = try await client.state(project: project).state
            guard open.blockers.contains(where: { $0.id == ownBlocker }) else { throw APIError(status: 0, code: "state", message: "own blocker not open after commit 1") }
            log("✓ own blocker is open")

            var fields2 = Fields()
            fields2.shipped = [FieldItem(id: "it_" + UUID().uuidString.lowercased(), text: "Selftest blocker \(runTag) fixed", resolves: [ownBlocker])]
            let c2 = try await client.commit(CommitRequest(id: "wc_" + UUID().uuidString.lowercased(), projectId: project, source: source,
                                                           imageBase64: png.base64EncodedString(), annotations: [],
                                                           comment: "Selftest \(runTag): blocker fixed",
                                                           summary: "Selftest \(runTag): blocker resolved", fields: fields2.cleaned()))
            log("✓ commit 2: \(c2.id) #\(c2.sequence ?? -1) resolves own blocker")
            let after = try await client.state(project: project).state
            guard !after.blockers.contains(where: { $0.id == ownBlocker }) else { throw APIError(status: 0, code: "state", message: "own blocker still open after resolve") }
            log("✓ own blocker resolved; \(after.blockers.count) other blocker(s) untouched")

            // T22 progress tree from the real feed + /context members.
            let ctxMembers = (try? await client.context(project: project).members) ?? []
            let feedNow = try await client.commits(project: project).commits
            let tree = ProgressTree.build(commits: feedNow, projectId: project, currentUserId: session.user.id, members: ctxMembers)
            guard let ownTask = tree.tasks.first(where: { $0.id == ownBlocker }), ownTask.status == .completed,
                  ownTask.evidence.count == 2, ownTask.evidence.last?.role == "Completed work" else {
                throw APIError(status: 0, code: "progress", message: "own blocker not shown as completed with its review evidence")
            }
            let colors = MemberColors().assign(tree.members)
            guard Set(colors.values).count == colors.count else { throw APIError(status: 0, code: "progress", message: "member colors not distinct") }
            log("✓ progress tree: own task completed with 2 records; \(tree.members.count) member(s) via /context=\(!ctxMembers.isEmpty), distinct colors")

            let feed = try await client.commits(project: project)
            guard feed.commits.contains(where: { $0.id == c.id }) else { throw APIError(status: 0, code: "feed", message: "commit missing from feed") }
            log("✓ feed: \(feed.commits.count) commits through #\(feed.throughSequence ?? -1)")
            if let path = c.evidence?.imageUrl {
                let img = try await client.imageData(path: path)
                log("✓ evidence image: \(img.count) bytes")
            }
            let state = try await client.state(project: project).state
            log("✓ state: blockers=\(state.blockers.count) next=\(state.next.count) shipped=\(state.shipped.count)")
            let cu = try await client.catchup(project: project)
            log("✓ catchup: \(cu.commits.count) since #\(cu.sinceSequence ?? -1), analyzer=\(cu.analyzer?.provider ?? "?")")
            let comment2 = try await client.addComment(commit: c.id, body: "selftest comment")
            log("✓ comment: \(comment2.id)")
            try await composerFlow(client: client, project: project, png: png, runTag: runTag, log: log)
            log("PASS")
            exit(0)
        } catch {
            log("FAIL: \(error.localizedDescription)")
            exit(1)
        }
    }

    /// Pure, network-free checks of composer/model state. Returns the first failure.
    static func modelChecks() -> String? {
        func provider(_ p: String?, _ st: String?) -> Provider.Mode { Provider(provider: p, status: st).mode }
        guard provider("manual", "not_configured") == .notConfigured else { return "manual/not_configured" }
        guard provider("manual", "ai_unavailable") == .unavailable else { return "ai_unavailable must not read as 'no AI connected'" }
        guard provider("deepseek", "completed") == .ai, provider("deepseek", "no_changes") == .ai else { return "configured provider" }

        func composer(_ project: String = "p", preview: Bool = false) -> ComposerModel {
            ComposerModel(image: NSImage(size: NSSize(width: 4, height: 4)), png: Data([1, 2, 3]),
                          source: Source(appName: "t", windowTitle: "", captureKind: preview ? "upload" : "region"),
                          projectId: project, isPreview: preview)
        }
        // A real capture is unsent material from the moment it arrives.
        let m = composer()
        guard m.isDirty else { return "a fresh capture (and its AI draft) must count as unsent" }
        guard m.mode == .card else { return "the capture opens as the light card" }
        guard m.primaryAction == .draftNow, !m.reviewReady else { return "no commit before any draft" }
        m.fields.shipped = [.new("done")]
        guard m.fieldCount == 1 else { return "field count" }
        let before = m.fields.shipped[0].id
        m.editAsNew()
        guard m.fields.shipped[0].id != before, m.fields.shipped[0].text == "done" else { return "edit-as-new must rebuild item ids, keep text" }

        let pv = composer(preview: true)
        guard pv.isPreview, !pv.isDirty else { return "preview flag / untouched fixture is not dirty" }
        pv.comment = "x"
        guard pv.isDirty else { return "preview edits count as dirty" }
        pv.loadSample()
        guard pv.isSample, !pv.summary.isEmpty, pv.beginDraft() == nil, !pv.reviewReady else { return "preview: labeled sample, no AI, no commit" }

        if let failure = aiFlowChecks(composer) { return failure }

        // Isolation: selftest/preview never use the saved account or endpoint.
        let app = AppState.shared
        guard AppState.isIsolatedLaunch, app.client.token == nil, app.endpoint == "http://preview.invalid",
              app.projectId == nil, !app.hasSavedSession else { return "isolated launch must not load the saved session" }

        // Window identity: an older composer's delayed finish must not close a newer one.
        let controller = ComposerController.shared
        func offscreenWindow() -> NSWindow {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.titled, .closable],
                             backing: .buffered, defer: true)
            w.isReleasedWhenClosed = false
            return w
        }
        let older = offscreenWindow(), newer = offscreenWindow()
        let olderModel = ComposerModel(image: NSImage(size: NSSize(width: 4, height: 4)), png: Data(),
                                       source: Source(appName: "t", windowTitle: "", captureKind: "region"), projectId: "p")
        let newerModel = ComposerModel(image: NSImage(size: NSSize(width: 4, height: 4)), png: Data(),
                                       source: Source(appName: "t", windowTitle: "", captureKind: "region"), projectId: "p")
        controller.adopt(older, model: olderModel)
        controller.forceClose(older)                      // user pressed Done on the old one
        guard !controller.isOpen else { return "closing the current window must clear it" }
        controller.adopt(newer, model: newerModel)        // a new capture opens
        newerModel.comment = "unsent work"
        controller.forceClose(older)                      // old 1.6s auto-finish fires late
        guard controller.isOpen else { return "a stale finish closed the newer composer" }
        guard controller.windowShouldClose(older) else { return "a stale window must not be guarded as current" }
        newerModel.committing = true
        guard controller.isCommitting, !controller.windowShouldClose(newer) else { return "close must be blocked while committing" }
        controller.closeAll()                              // sign-in/out path while committing
        guard controller.isOpen else { return "closeAll must not close a composer that is committing" }
        newerModel.committing = false
        controller.forceClose(newer)
        guard !controller.isOpen else { return "forceClose(current) must close it" }
        return nil
    }

    /// T14 against a (scratch) server through the real ComposerModel: arrival
    /// draft with empty context, no Git write without explicit Commit, the
    /// latest context is what commits, frozen retry never re-drafts, and an
    /// unreachable AI keeps the material.
    static func composerFlow(client: APIClient, project: String, png: Data, runTag: String,
                             log: (String) -> Void) async throws {
        func fail(_ m: String) -> APIError { APIError(status: 0, code: "composer", message: m) }
        let source = Source(appName: "CmdShift3 selftest", windowTitle: "T14", captureKind: "region")
        let count0 = try await client.commits(project: project).commits.count

        let m = ComposerModel(image: NSImage(data: png) ?? NSImage(), png: png, source: source, projectId: project)
        await m.arrive(client)
        await m.arrive(client)   // arrival runs once per capture
        guard m.draftRequestsSent == 1, m.appliedInput?.comment == "", m.organizer != nil else {
            throw fail("arrival must draft once with empty context (sent=\(m.draftRequestsSent), failure=\(m.aiFailure ?? "-"))")
        }
        log("✓ arrival draft with empty context: provider=\(m.organizer?.provider ?? "?") status=\(m.organizer?.status ?? "?")")
        guard try await client.commits(project: project).commits.count == count0 else { throw fail("a draft wrote a commit") }
        if !m.reviewReady {
            guard await !m.commit(client), m.frozen == nil else { throw fail("commit before review must be refused") }
        }
        guard try await client.commits(project: project).commits.count == count0 else { throw fail("unreviewed commit reached Git") }
        log("✓ no Git write from draft or before review (feed still \(count0))")

        let latest = "T14 latest context \(runTag)"
        m.comment = latest
        guard m.needsUpdate, !m.reviewReady || m.manualReview else { throw fail("context change must need an update") }
        await m.draft(client)
        guard m.appliedInput == m.currentInput, m.draftRequestsSent == 2 else { throw fail("update draft for the latest context") }
        if !m.reviewReady {
            guard m.primaryAction == .continueManually || m.primaryAction == .retryAI else { throw fail("no-AI path must offer manual") }
            m.continueManually()
            log("✓ no AI on this server → explicit Continue manually")
        }
        guard m.reviewReady, await m.commit(client), let r = m.result else { throw fail("reviewed commit: \(m.error ?? "-")") }
        guard r.comment == latest else { throw fail("commit must carry the latest context") }
        log("✓ reviewed commit #\(r.sequence ?? -1) sha=\(r.shortSha ?? "nil") carries the latest context")

        await m.draft(client)
        m.result = nil   // simulate a lost response → retry the frozen request
        guard await m.commit(client), m.result?.git?.sha == r.git?.sha, m.draftRequestsSent == 2 else {
            throw fail("frozen retry must resend the same request without AI")
        }
        guard try await client.commits(project: project).commits.count == count0 + 1 else { throw fail("retry duplicated the commit") }
        log("✓ frozen retry: same SHA, no new AI request, one commit")

        let dead = APIClient(baseURL: URL(string: "http://127.0.0.1:9")!, token: client.token)
        let f = ComposerModel(image: NSImage(data: png) ?? NSImage(), png: png, source: source, projectId: project)
        f.comment = "keep me"
        await f.arrive(dead)
        guard f.aiFailure != nil, f.comment == "keep me", f.png == png, !f.isLocked, f.primaryAction == .retryAI else {
            throw fail("unreachable AI must keep the material and offer Retry AI")
        }
        log("✓ AI unreachable: material kept, Retry AI / Continue manually offered")
    }

    /// T14 AI-first state rules, network-free: generation/revision guards,
    /// review gating, manual fallback, failure keeps material, frozen retry.
    static func aiFlowChecks(_ composer: (String, Bool) -> ComposerModel) -> String? {
        func ai(_ summary: String, _ shipped: String) -> DraftResponse {
            var f = Fields()
            f.shipped = [.new(shipped)]
            return DraftResponse(summary: summary, fields: f, organizer: Provider(provider: "deepseek", status: "completed"), warnings: nil)
        }

        // A→B→A with overlapping requests: only the latest generation applies.
        let m = composer("A", false)
        guard let g1 = m.beginDraft() else { return "arrival draft must start" }
        m.projectId = "B"
        guard let g2 = m.beginDraft() else { return "B draft" }
        m.projectId = "A"
        guard let g3 = m.beginDraft() else { return "A again" }
        guard !m.applyDraft(ai("old A", "x"), gen: g1.gen, input: g1.input) else { return "stale A (gen 1) applied" }
        guard !m.applyDraft(ai("B", "y"), gen: g2.gen, input: g2.input) else { return "stale B applied after switching back" }
        guard m.drafting else { return "latest request still in flight" }
        guard m.applyDraft(ai("fresh A", "z"), gen: g3.gen, input: g3.input) else { return "latest A must apply" }
        guard m.summary == "fresh A", m.fields.shipped.map(\.text) == ["z"] else { return "applied content" }
        guard m.reviewReady, m.primaryAction == .commit else { return "a current AI draft is ready to review/commit" }

        // R26: A→B→A with no replacement request. Equal values are still a new
        // input revision: the pending A result/failure must not apply.
        for (label, flip) in [("comment", { (c: ComposerModel) in c.comment = "B"; c.comment = "A" }),
                              ("project", { (c: ComposerModel) in c.projectId = "B"; c.projectId = "A" })] {
            let r = composer("A", false)
            r.comment = "A"
            guard let pending = r.beginDraft() else { return "\(label) round trip: draft" }
            let rev = r.inputRevision
            flip(r)
            guard r.inputRevision == rev + 2, r.currentInput.projectId == "A", r.currentInput.comment == "A" else {
                return "\(label) A→B→A must bump inputRevision twice (values equal again)"
            }
            guard !r.applyDraft(ai("pending A", "p"), gen: pending.gen, input: pending.input) else {
                return "\(label) A→B→A: pending A response applied without a new request"
            }
            guard !r.drafting, r.appliedInput == nil, r.summary.isEmpty, r.draftRequestsSent == 0 else {
                return "\(label) A→B→A: dropped response changed state"
            }
            guard !r.reviewReady, r.primaryAction == .draftNow else { return "\(label) A→B→A: must re-draft before Commit" }
            let f = composer("A", false)
            guard let pf = f.beginDraft() else { return "\(label) failure: draft" }
            flip(f)
            guard !f.failDraft(APIError(status: 0, code: "network", message: "x"), gen: pf.gen, input: pf.input),
                  f.aiFailure == nil, !f.drafting else {
                return "\(label) A→B→A: pending A failure applied"
            }

            // Applied draft, then A→B→A: review is stale → Update draft, never Commit.
            let s = composer("A", false)
            guard let g = s.beginDraft(), s.applyDraft(ai("A", "a"), gen: g.gen, input: g.input), s.reviewReady else {
                return "\(label) review: draft"
            }
            flip(s)
            guard s.needsUpdate, !s.reviewReady, s.primaryAction == .updateDraft, !s.isLocked else {
                return "\(label) A→B→A after a draft must require Update draft"
            }
        }
        // Back to the drafted (empty) context still counts as stale: commit()'s
        // `isLocked || reviewReady` gate stays closed.
        let st = composer("A", false)
        guard let gs = st.beginDraft(), st.applyDraft(ai("A", "a"), gen: gs.gen, input: gs.input) else { return "stale commit: draft" }
        st.comment = "B"; st.comment = ""
        guard st.needsUpdate, !st.reviewReady, !st.isLocked else { return "stale review must block Commit" }

        // Context edited mid-flight: the result is for old input → dropped.
        guard let g4 = m.beginDraft() else { return "update draft" }
        m.comment = "typed while drafting"
        guard !m.applyDraft(ai("stale", "s"), gen: g4.gen, input: g4.input) else { return "result for edited context applied" }
        guard !m.drafting, m.summary == "fresh A" else { return "dropped result must not change the draft" }
        guard m.needsUpdate, !m.reviewReady, m.primaryAction == .updateDraft else { return "context change → Update draft, not Commit" }

        // Human edits survive an update; the new draft becomes reviewable.
        m.summary = "my own summary"
        guard let g5 = m.beginDraft() else { return "update" }
        guard m.applyDraft(ai("ai summary 2", "z2"), gen: g5.gen, input: g5.input) else { return "update must apply" }
        guard m.summary == "my own summary" else { return "human-edited summary must be kept" }
        guard !m.needsUpdate, m.reviewReady else { return "updated draft reviewable" }

        // Project switch drops resolves and AI state.
        m.fields.shipped[0].resolves = ["it_x"]
        m.continueManually()
        m.projectId = "B"
        m.resetForProjectSwitch()   // projectChanged's state part (its re-draft is network)
        guard m.fields.shipped.allSatisfy({ ($0.resolves ?? []).isEmpty }), m.organizer == nil, !m.manualReview, m.appliedInput == nil else {
            return "project switch must clear resolves / AI / manual state"
        }

        // Not configured: no silent bypass — explicit Continue manually first.
        let n = composer("A", false)
        guard let gn = n.beginDraft() else { return "nc draft" }
        n.applyDraft(DraftResponse(summary: nil, fields: Fields(), organizer: Provider(provider: "manual", status: "not_configured"), warnings: nil),
                     gen: gn.gen, input: gn.input)
        guard !n.reviewReady, n.primaryAction == .continueManually else { return "no AI → Continue manually before Commit" }
        n.continueManually()
        guard n.reviewReady, n.primaryAction == .commit else { return "manual review enables Commit" }

        // AI unavailable / HTTP 429 / network: state is explicit, material kept.
        for (err, needle) in [(APIError(status: 429, code: "rate_limited", message: "slow down"), "limit"),
                              (APIError(status: 0, code: "network", message: "offline"), "reach")] {
            let f = composer("A", false)
            f.comment = "keep me"
            f.annotations = [Annotation(type: .rect, x: 0, y: 0, w: 0.2, h: 0.2, text: nil, color: "#F97066")]
            guard let gf = f.beginDraft() else { return "fail draft" }
            f.failDraft(err, gen: gf.gen, input: gf.input)
            guard let msg = f.aiFailure, msg.contains(needle) else { return "failure message for \(err.code)" }
            guard f.comment == "keep me", f.annotations.count == 1, f.png == Data([1, 2, 3]), !f.isLocked else { return "failure must keep material" }
            guard !f.reviewReady, f.primaryAction == .retryAI, f.offersManual else { return "failure → Retry AI / Continue manually" }
        }
        let u = composer("A", false)
        guard let gu = u.beginDraft() else { return "unavailable draft" }
        u.applyDraft(DraftResponse(summary: nil, fields: nil, organizer: Provider(provider: "manual", status: "ai_unavailable"), warnings: nil),
                     gen: gu.gen, input: gu.input)
        guard !u.reviewReady, u.primaryAction == .retryAI, u.offersManual else { return "ai_unavailable → Retry AI / Continue manually" }

        // Frozen: no AI after the first write attempt; late drafts never apply.
        let z = composer("A", false)
        guard let gz = z.beginDraft() else { return "z draft" }
        let frozenReq = z.freeze()
        guard z.freeze().id == frozenReq.id else { return "freeze is stable" }
        guard !z.applyDraft(ai("late", "l"), gen: gz.gen, input: gz.input) else { return "a draft applied after freezing" }
        guard z.beginDraft() == nil, z.primaryAction == .retryCommit else { return "frozen retry must never re-draft" }
        return nil
    }

    /// JSON dump of ProgressTree + member colors for a fixture (parity with the web tree).
    static func dumpProgress(_ path: String) {
        struct Fixture: Decodable { let projectId: String; let currentUserId: String?; let members: [User]; let commits: [WorkCommit] }
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase
        guard let data = FileManager.default.contents(atPath: path), let f = try? d.decode(Fixture.self, from: data) else {
            print("FAIL: cannot read progress fixture \(path)"); exit(2)
        }
        let tree = ProgressTree.build(commits: f.commits, projectId: f.projectId, currentUserId: f.currentUserId, members: f.members)
        let colors = MemberColors().assign(tree.members)
        func ev(_ e: ProgressEvidence) -> [String: Any] {
            ["commit_id": e.commitId, "item_id": e.itemId ?? NSNull(), "role": e.role, "text": e.text, "mine": e.mine,
             "git_sha": e.gitSha, "facts": e.facts.map { ["kind": $0.kind, "text": $0.text] }]
        }
        let out: [String: Any] = [
            "tasks": tree.tasks.map { ["id": $0.id, "kind": $0.kind, "status": $0.status.rawValue, "sequence": $0.sequence,
                                       "evidence": $0.evidence.map(ev)] },
            "supporting": tree.supporting.map(ev),
            "members": tree.members.map { ["id": $0.id, "name": $0.name] },
            "commit_count": tree.commitCount, "mine_count": tree.mineCount,
            "colors": colors,
        ]
        let json = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted])
        print(String(data: json, encoding: .utf8)!)
    }

    /// Small generated PNG so the selftest needs no screen-recording permission.
    static func samplePNG() -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 400, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.2, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: 640, height: 400).fill()
        ("CmdShift3 selftest " + ISO8601DateFormatter().string(from: Date()) as NSString)
            .draw(at: NSPoint(x: 40, y: 190), withAttributes: [.font: NSFont.systemFont(ofSize: 28, weight: .bold),
                                                                 .foregroundColor: NSColor.white])
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }
}
