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
        log("✓ model checks (AI status labels, dirty/close guard, edit-as-new ids, preview)")
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

        let m = ComposerModel(image: NSImage(size: NSSize(width: 4, height: 4)), png: Data(),
                              source: Source(appName: "t", windowTitle: "", captureKind: "region"), projectId: "p")
        guard !m.isDirty else { return "fresh composer must not be dirty" }
        m.comment = "  "
        guard !m.isDirty else { return "whitespace comment is not dirty" }
        m.annotations = [Annotation(type: .rect, x: 0, y: 0, w: 0.1, h: 0.1, text: nil, color: "#F97066")]
        guard m.isDirty else { return "a mark makes the composer dirty" }
        m.annotations = []
        m.fields.shipped = [.new("done")]
        guard m.isDirty, m.fieldCount == 1 else { return "a field makes the composer dirty" }
        guard !m.fieldsExpanded else { return "fields start folded" }

        let before = m.fields.shipped[0].id
        m.editAsNew()
        guard m.fields.shipped[0].id != before, m.fields.shipped[0].text == "done" else { return "edit-as-new must rebuild item ids, keep text" }

        let pv = ComposerModel(image: NSImage(size: NSSize(width: 4, height: 4)), png: Data(),
                               source: Source(appName: "t", windowTitle: "", captureKind: "upload"), projectId: "p", isPreview: true)
        guard pv.isPreview else { return "preview flag" }

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
