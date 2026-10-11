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
        let endpoint = arg("--endpoint") ?? AppState.defaultEndpoint
        let client = APIClient(baseURL: URL(string: endpoint)!, token: nil)
        func log(_ s: String) { print(s); fflush(stdout) }
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
