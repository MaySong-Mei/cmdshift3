import AppKit
import SwiftUI

extension Notification.Name {
    static let cmd3NeedsSignIn = Notification.Name("cmd3NeedsSignIn")
    /// Reopening the app (Dock/Finder) should bring up the full workspace.
    static let cmd3OpenWorkspace = Notification.Name("cmd3OpenWorkspace")
    /// The durable capture inbox changed (saved, committed or discarded).
    static let cmd3InboxChanged = Notification.Name("cmd3InboxChanged")
}

enum MainTab: String, Hashable {
    case commit, catchup, feed, progress, people, state, ask
}

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    /// New installs connect to the public service; a saved endpoint
    /// (e.g. the local 4317 demo) keeps being used.
    static let defaultEndpoint = "https://cmdshift3-web-production.up.railway.app"
    static let localEndpoint = "http://127.0.0.1:4317"

    /// `--preview-capture <png>`: open the editor on a fixture for layout review,
    /// with no network, no hotkey and no UserDefaults writes.
    static let previewRequested = CommandLine.arguments.contains("--preview-capture")
    static let previewCapturePath: String? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--preview-capture"), i + 1 < a.count, !a[i + 1].hasPrefix("--") else { return nil }
        return a[i + 1]
    }()
    /// Preview and selftest launches run on an in-memory AppState: they never
    /// read the saved account, restore a session, poll, or write UserDefaults.
    static let isIsolatedLaunch = previewRequested || CommandLine.arguments.contains("--selftest")
    var isPreview: Bool { Self.previewRequested }
    private var persists: Bool { !Self.isIsolatedLaunch }
    private static let isolatedEndpoint = "http://preview.invalid"

    @Published var endpoint: String {
        didSet {
            if persists { UserDefaults.standard.set(endpoint, forKey: "endpoint") }
            client.baseURL = URL(string: endpoint) ?? client.baseURL
        }
    }
    @Published var user: User?
    @Published var projects: [Project] = []
    @Published var projectId: String? {
        didSet {
            if persists { UserDefaults.standard.set(projectId, forKey: "projectId") }
            if oldValue != projectId {
                commits = []; state = nil; catchup = nil; members = []; membersLoadedFor = nil
                resetConversationIfScopeChanged()
                Task { await refresh() }
            }
        }
    }
    @Published var commits: [WorkCommit] = []
    @Published var state: ProjectState?
    @Published var catchup: CatchupResponse?
    @Published var lastError: String?
    @Published var signingIn = false
    @Published var capturing = false
    @Published var mainTab: MainTab = .catchup
    /// Durable pre-commit captures. Isolated launches (selftest/preview) never touch the real folder.
    let draftStore: DraftStore? = AppState.isIsolatedLaunch ? nil : DraftStore.live()
    @Published var inbox: [StoredDraft] = []
    /// Set when the global shortcut failed to register (shown at the capture entry).
    @Published var hotKeyProblem: String?
    /// Last capture-entry failure (permission, screenshot error), shown where capture starts.
    @Published var captureProblem: String?
    var inboxForProject: [StoredDraft] { inbox.filter { $0.projectId == projectId } }

    func reloadInbox() {
        guard let draftStore, let user else { inbox = []; return }
        inbox = draftStore.list(endpoint: endpoint, userId: user.id)
    }

    /// Ask transcript, in memory only, scoped to project + account (reset on change).
    @Published var conversation: [ChatTurn] = []
    @Published var asking = false
    private var conversationScope: String?

    /// Project members from the context API (falls back to commit authors).
    @Published var members: [User] = []
    let memberColors = MemberColors()
    private var membersLoadedFor: String?

    /// Task-organized progress, rebuilt from the already-loaded feed (no extra request).
    var progressTree: ProgressTree {
        guard let pid = projectId else { return ProgressTree(tasks: [], supporting: [], members: [], commitCount: 0, mineCount: 0) }
        let tree = ProgressTree.build(commits: commits, projectId: pid, currentUserId: user?.id, members: members)
        memberColors.assign(tree.members)
        return tree
    }
    @Published var selectedCommitId: String?

    let client: APIClient
    private var lastExternalApp: NSRunningApplication?
    private var timer: Timer?
    private var imageCache: [String: NSImage] = [:]

    init() {
        let isolated = Self.isIsolatedLaunch
        let endpoint = isolated ? Self.isolatedEndpoint
            : (UserDefaults.standard.string(forKey: "endpoint") ?? Self.defaultEndpoint)
        self.endpoint = endpoint
        self.projectId = isolated ? nil : UserDefaults.standard.string(forKey: "projectId")
        // Demo login token: kept in UserDefaults rather than Keychain because the
        // ad-hoc signed build changes signature every rebuild (Keychain would prompt).
        self.client = APIClient(baseURL: URL(string: endpoint) ?? URL(string: Self.defaultEndpoint)!,
                                token: isolated ? nil : UserDefaults.standard.string(forKey: "token"))

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated {
                if let app, app.processIdentifier != getpid() { self?.lastExternalApp = app }
            }
        }

        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != getpid() {
            lastExternalApp = front
        }
        if client.token != nil && !isolated { Task { await restore() } }
        NotificationCenter.default.addObserver(forName: .cmd3InboxChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reloadInbox() }
        }
    }

    /// Opens the composer on a fixture PNG (see `previewCapturePath`).
    func openPreview(path: String) {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)), let image = NSImage(data: data) else {
            print("preview-capture: cannot read PNG at \(path)")
            exit(2)
        }
        let source = Source(appName: "Preview fixture", windowTitle: URL(fileURLWithPath: path).lastPathComponent, captureKind: "upload")
        ComposerController.shared.open(image: image, png: data, source: source, app: self, preview: true)
    }

    var currentProject: Project? { projects.first { $0.id == projectId } }
    var unseenCount: Int { catchup?.commits.count ?? 0 }
    var isSignedIn: Bool { user != nil }
    var hasSavedSession: Bool { client.token != nil }
    var isLocalEndpoint: Bool {
        let host = URL(string: endpoint)?.host?.lowercased() ?? ""
        return host == "127.0.0.1" || host == "localhost" || host.hasSuffix(".local")
    }

    // MARK: Session

    func signIn(code: String) async {
        guard persists else {
            lastError = "Preview mode — sign-in is disabled."
            return
        }
        // Switching identity mid-commit would orphan or misattribute the request.
        let busy = "A commit is in progress — wait for it to finish before switching accounts."
        guard !ComposerController.shared.isCommitting else {
            lastError = busy
            return
        }
        signingIn = true
        defer { signingIn = false }
        do {
            let s = try await client.session(code: code.trimmingCharacters(in: .whitespaces))
            // Re-check after the await: the user may have pressed Commit while the
            // sign-in request was in flight. Then keep the current identity and
            // revoke the session we just obtained instead of applying it.
            guard !ComposerController.shared.isCommitting else {
                lastError = busy
                let unused = APIClient(baseURL: client.baseURL, token: s.token)
                Task { await unused.logout() }
                return
            }
            // Compare server + account (same user id on another server is a different scope).
            let newScope = DraftStore.scopeKey(endpoint: endpoint, userId: s.user.id)
            let previousScope = lastScopeKey ?? user.map { DraftStore.scopeKey(endpoint: endpoint, userId: $0.id) }
            if let previousScope, previousScope != newScope {
                guard ComposerController.shared.closeAll() else {
                    lastError = "Couldn't save the open capture, so the account wasn't switched."
                    let unused = APIClient(baseURL: client.baseURL, token: s.token)
                    Task { await unused.logout() }
                    return
                }
            }
            lastScopeKey = newScope
            client.token = s.token
            UserDefaults.standard.set(s.token, forKey: "token")
            apply(user: s.user, projects: s.projects)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func restore() async {
        do {
            let me = try await client.me()
            apply(user: me.user, projects: me.projects)
        } catch let e as APIError where e.status == 401 {
            clearSession()
            lastError = "Your session expired — sign in again."
            NotificationCenter.default.post(name: .cmd3NeedsSignIn, object: nil)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func signOut() async {
        guard !ComposerController.shared.isCommitting else {
            lastError = "A commit is in progress — wait for it to finish before signing out."
            return
        }
        guard ComposerController.shared.closeAll() else {
            lastError = "Couldn't save the open capture, so you weren't signed out."
            return
        }
        await client.logout()
        clearSession()
    }

    private func apply(user: User, projects: [Project]) {
        self.user = user
        self.projects = projects
        resetConversationIfScopeChanged()
        reloadInbox()
        if projectId == nil || !projects.contains(where: { $0.id == projectId }) {
            projectId = projects.first?.id
        } else {
            Task { await refresh() }
        }
        startPolling()
    }

    struct ChatTurn: Identifiable, Hashable {
        let id = UUID()
        let role: String                 // "user" | "assistant" | "error"
        let text: String
        var analyzer: Provider? = nil
        var evidence: [ConversationEvidence] = []
        var coverage: ConversationCoverage? = nil
    }

    /// History is untrusted dialogue context: clear it whenever project or account changes.
    func resetConversationIfScopeChanged() {
        let scope = "\(user?.id ?? "-")|\(projectId ?? "-")"
        if scope != conversationScope {
            conversation = []
            conversationScope = scope
        }
    }

    func ask(_ raw: String) async {
        let question = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard persists, !asking, let pid = projectId, !question.isEmpty, question.count <= ConversationRequest.maxQuestion else { return }
        resetConversationIfScopeChanged()
        let scope = conversationScope
        let history = ConversationRequest.boundedHistory(conversation.compactMap {
            $0.role == "error" ? nil : ConversationMessage(role: $0.role, content: $0.text)
        })
        conversation.append(ChatTurn(role: "user", text: question))
        asking = true
        defer { asking = false }
        do {
            let r = try await client.conversation(project: pid, question: question, history: history)
            guard scope == conversationScope else { return }   // project/account changed mid-flight
            conversation.append(ChatTurn(role: "assistant", text: r.answer, analyzer: r.analyzer, evidence: r.evidence, coverage: r.coverage))
        } catch let e as APIError {
            guard scope == conversationScope else { return }
            let msg: String = switch e.status {
            case 429: "Too many questions right now — wait a minute and ask again."
            case 404: "Project questions aren't available on this server yet."
            case 401: "Your session expired — sign in again."
            default: e.localizedDescription
            }
            conversation.append(ChatTurn(role: "error", text: msg))
        } catch {
            conversation.append(ChatTurn(role: "error", text: error.localizedDescription))
        }
    }

    private func clearSession() {
        // An open composer survives an expired session (re-sign-in as the same
        // user keeps the work); signIn closes it if a different user signs in.
        if let id = user?.id { lastScopeKey = DraftStore.scopeKey(endpoint: endpoint, userId: id) }
        client.token = nil
        if persists { UserDefaults.standard.removeObject(forKey: "token") }
        user = nil; projects = []; commits = []; state = nil; catchup = nil
        conversation = []; conversationScope = nil
        inbox = []
        timer?.invalidate(); timer = nil
    }

    private func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    // MARK: Data

    private var refreshing = false
    /// Server + account of the last session (drafts and composers are bound to it).
    private var lastScopeKey: String?
    private var pendingRefresh: (force: Bool, queued: Bool) = (false, false)

    /// Commits + state on every tick. Catch-up (which may call the AI on the
    /// server) only when the project's sequence moved, or when forced.
    /// Calls arriving mid-flight are coalesced into one follow-up refresh.
    func refresh(forceCatchup: Bool = false) async {
        guard persists, isSignedIn, projectId != nil else { return }
        if refreshing {
            pendingRefresh = (pendingRefresh.force || forceCatchup, true)
            return
        }
        refreshing = true
        // Unstructured so a cancelled caller (e.g. a view's .task) cannot
        // cancel the shared loop or queued refreshes.
        await Task { @MainActor in
            await refreshOnce(forceCatchup: forceCatchup)
            while pendingRefresh.queued {
                let force = pendingRefresh.force
                pendingRefresh = (false, false)
                await refreshOnce(forceCatchup: force)
            }
            refreshing = false
        }.value
    }

    private func refreshOnce(forceCatchup: Bool) async {
        guard isSignedIn, let pid = projectId else { return }
        let token = client.token
        do {
            async let c = client.commits(project: pid)
            async let s = client.state(project: pid)
            let (cr, sr) = try await (c, s)
            guard pid == projectId, token == client.token else { return }
            commits = cr.commits
            state = sr.state
            if membersLoadedFor != pid || forceCatchup {
                // Older servers may not have /context; the tree then uses commit authors.
                if let ctx = try? await client.context(project: pid), pid == projectId, token == client.token {
                    members = ctx.members
                    membersLoadedFor = pid
                }
            }
            let moved = cr.throughSequence != nil && cr.throughSequence != catchup?.throughSequence
            if forceCatchup || catchup == nil || moved {
                let ur = try await client.catchup(project: pid)
                guard pid == projectId, token == client.token else { return }
                catchup = ur
            }
            lastError = nil
        } catch let e as APIError where e.status == 401 {
            clearSession()
            lastError = "Session expired — sign in again."
            NotificationCenter.default.post(name: .cmd3NeedsSignIn, object: nil)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markSeen() async {
        guard persists, let pid = projectId, let through = catchup?.throughSequence else { return }
        do {
            _ = try await client.seen(project: pid, through: through)
            await refresh(forceCatchup: true)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func image(path: String) async -> NSImage? {
        guard persists else { return nil }
        if let cached = imageCache[path] { return cached }
        guard let data = try? await client.imageData(path: path), let img = NSImage(data: data) else { return nil }
        imageCache[path] = img
        return img
    }

    // MARK: Capture

    /// Hotkey / panel entry point: system region picker → composer window.
    func startCapture() {
        guard !capturing, !isPreview else { return }
        // A capture in progress is saved to the inbox first (never silently dropped);
        // while it is committing, it stays in front instead.
        if ComposerController.shared.isOpen && ComposerController.shared.isCommitting {
            ComposerController.shared.bringToFront()
            return
        }
        guard isSignedIn, projectId != nil else {
            lastError = "Sign in before committing."
            NotificationCenter.default.post(name: .cmd3NeedsSignIn, object: nil)
            return
        }
        if !CGPreflightScreenCaptureAccess() {
            // First time: let the system prompt speak alone. Afterwards explain.
            let asked = UserDefaults.standard.bool(forKey: "askedScreenRecording")
            UserDefaults.standard.set(true, forKey: "askedScreenRecording")
            if !CGRequestScreenCaptureAccess() {
                if asked {
                    showScreenRecordingAlert()
                } else {
                    lastError = "Allow Screen Recording for CmdShift3 in System Settings, then quit and reopen it. Press \(HotKey.displayString) again for help."
                    captureProblem = "Screen Recording is off for this CmdShift3 (\(Bundle.main.bundlePath)). Turn it on in System Settings, then reopen the app."
                }
                return
            }
        }
        let front = NSWorkspace.shared.frontmostApplication
        let app = (front?.processIdentifier == getpid()) ? (lastExternalApp ?? Capture.topmostOtherApp()) : front
        let source = Capture.source(for: app)
        guard ComposerController.shared.stashCurrent() else { return }
        guard let boundUser = user, let boundProject = projectId else { return }
        let bound = (endpoint: endpoint, userId: boundUser.id)
        captureProblem = nil
        capturing = true
        closeMenuBarPanel()
        Task {
            defer { capturing = false }
            try? await Task.sleep(for: .milliseconds(150))
            switch await Capture.interactive() {
            case .cancelled:
                return
            case .failed(let message):
                showAlert(title: "Screenshot failed", message: message)
            case .captured(let raw):
                let png = Capture.pngWithinLimit(raw)
                guard let image = NSImage(data: png) else {
                    showAlert(title: "Screenshot failed", message: "The captured image could not be decoded as PNG.")
                    return
                }
                openCapture(image: image, png: png, source: source, bound: bound, projectId: boundProject)
            }
        }
    }

    /// Opens a capture under the scope taken before the async step. If the session
    /// changed meanwhile, the capture goes to the original account's inbox instead.
    private func openCapture(image: NSImage, png: Data, source: Source,
                             bound: (endpoint: String, userId: String), projectId pid: String) {
        let now = user.map { DraftStore.scopeKey(endpoint: endpoint, userId: $0.id) }
        if now != DraftStore.scopeKey(endpoint: bound.endpoint, userId: bound.userId) {
            let m = ComposerModel(image: image, png: png, source: source, projectId: pid)
            switch Self.stashForeignCapture(m, store: draftStore, bound: bound) {
            case .saved:
                captureProblem = "The account or server changed during the capture, so it was saved to the original account's Commit inbox instead of opening here."
                return
            case .keepOpen(let reason):
                // Never drop the only copy: keep it open, bound to its original
                // account (draft/commit stay refused there) so saving can be retried.
                captureProblem = "The account or server changed during the capture and it couldn't be saved (\(reason)). It's kept open so you can retry."
            }
        }
        ComposerController.shared.open(image: image, png: png, source: source, app: self, scope: bound, projectId: pid)
    }

    enum ForeignCaptureOutcome: Equatable { case saved, keepOpen(String) }

    /// Saves a capture whose session changed mid-capture into its original inbox.
    /// Reports success only when the write actually succeeded.
    static func stashForeignCapture(_ m: ComposerModel, store: DraftStore?,
                                    bound: (endpoint: String, userId: String)) -> ForeignCaptureOutcome {
        guard let store else { return .keepOpen("no local draft folder") }
        do {
            try store.save(m.snapshot(endpoint: bound.endpoint, userId: bound.userId), png: m.png)
            return .saved
        } catch {
            return .keepOpen(error.localizedDescription)
        }
    }

    /// Brings an existing screenshot file into the inbox (explicit file choice only;
    /// nothing is scanned automatically).
    func importScreenshot() {
        guard persists, isSignedIn, projectId != nil else {
            lastError = "Sign in before importing a screenshot."
            return
        }
        guard let boundUser = user, let boundProject = projectId else { return }
        let bound = (endpoint: endpoint, userId: boundUser.id)
        let panel = NSOpenPanel()
        panel.title = "Import a screenshot"
        panel.allowedContentTypes = [.png, .jpeg, .heic, .tiff]
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let raw = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: raw),
              let pngData = rep.representation(using: .png, properties: [:]) else {
            lastError = "That file isn't an image CmdShift3 can read."
            return
        }
        let png = Capture.pngWithinLimit(pngData)
        guard let image = NSImage(data: png) else { return }
        let source = Source(appName: "Imported screenshot", windowTitle: url.lastPathComponent, captureKind: "upload")
        openCapture(image: image, png: png, source: source, bound: bound, projectId: boundProject)
    }

    func resumeDraft(_ d: StoredDraft) { ComposerController.shared.resume(d, app: self) }

    /// Confirmed delete of a saved capture from the inbox list.
    func discardDraft(_ d: StoredDraft) {
        if ComposerController.shared.openDraftId == d.id {
            ComposerController.shared.bringToFront()
            return                                   // discard from its own window
        }
        let alert = NSAlert()
        alert.messageText = "Discard this capture?"
        alert.informativeText = "“\(d.title)” will be deleted from this Mac. Nothing was committed."
        alert.addButton(withTitle: "Keep")
        alert.addButton(withTitle: "Discard")
        alert.buttons[1].hasDestructiveAction = true
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        draftStore?.remove(d)
        reloadInbox()
    }

    /// Toggle the status item instead of orderOut, so SwiftUI's MenuBarExtra
    /// state stays in sync and the next icon click opens the panel again.
    private func closeMenuBarPanel() {
        guard NSApp.windows.contains(where: { $0.isVisible && $0.className.contains("MenuBarExtra") }) else { return }
        for w in NSApp.windows where w.className.contains("NSStatusBarWindow") {
            if let button = Self.findStatusButton(in: w.contentView) {
                button.performClick(nil)
                return
            }
        }
        for w in NSApp.windows where w.isVisible && w.className.contains("MenuBarExtra") { w.orderOut(nil) }
    }

    private static func findStatusButton(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let b = view as? NSStatusBarButton { return b }
        for sub in view.subviews { if let b = findStatusButton(in: sub) { return b } }
        return nil
    }

    private func showScreenRecordingAlert() {
        lastError = "Screen Recording permission is off for CmdShift3."
        captureProblem = "Screen Recording is off for this CmdShift3 (\(Bundle.main.bundlePath)). Turn it on in System Settings, then reopen the app."
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Allow Screen Recording"
        alert.informativeText = """
        CmdShift3 needs Screen Recording to capture your work.

        System Settings → Privacy & Security → Screen Recording → turn on CmdShift3, then quit and reopen CmdShift3.
        """
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    private func showAlert(title: String, message: String) {
        lastError = "\(title): \(message)"
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}
