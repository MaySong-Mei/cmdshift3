import AppKit
import SwiftUI

extension Notification.Name {
    static let cmd3NeedsSignIn = Notification.Name("cmd3NeedsSignIn")
}

enum MainTab: String, Hashable {
    case catchup, feed, state
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
    static let previewCapturePath: String? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--preview-capture"), i + 1 < a.count else { return nil }
        return a[i + 1]
    }()
    var isPreview: Bool { Self.previewCapturePath != nil }

    @Published var endpoint: String {
        didSet {
            UserDefaults.standard.set(endpoint, forKey: "endpoint")
            client.baseURL = URL(string: endpoint) ?? client.baseURL
        }
    }
    @Published var user: User?
    @Published var projects: [Project] = []
    @Published var projectId: String? {
        didSet {
            UserDefaults.standard.set(projectId, forKey: "projectId")
            if oldValue != projectId {
                commits = []; state = nil; catchup = nil
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
    @Published var selectedCommitId: String?

    let client: APIClient
    private var lastExternalApp: NSRunningApplication?
    private var timer: Timer?
    private var imageCache: [String: NSImage] = [:]

    init() {
        let endpoint = UserDefaults.standard.string(forKey: "endpoint") ?? Self.defaultEndpoint
        self.endpoint = endpoint
        self.projectId = UserDefaults.standard.string(forKey: "projectId")
        // Demo login token: kept in UserDefaults rather than Keychain because the
        // ad-hoc signed build changes signature every rebuild (Keychain would prompt).
        self.client = APIClient(baseURL: URL(string: endpoint) ?? URL(string: Self.defaultEndpoint)!,
                                token: UserDefaults.standard.string(forKey: "token"))

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
        if client.token != nil && Self.previewCapturePath == nil { Task { await restore() } }
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
        signingIn = true
        defer { signingIn = false }
        do {
            let s = try await client.session(code: code.trimmingCharacters(in: .whitespaces))
            if let previous = lastUserId ?? user?.id, previous != s.user.id {
                ComposerController.shared.closeAll()
            }
            lastUserId = s.user.id
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
        ComposerController.shared.closeAll()
        await client.logout()
        clearSession()
    }

    private func apply(user: User, projects: [Project]) {
        self.user = user
        self.projects = projects
        if projectId == nil || !projects.contains(where: { $0.id == projectId }) {
            projectId = projects.first?.id
        } else {
            Task { await refresh() }
        }
        startPolling()
    }

    private func clearSession() {
        // An open composer survives an expired session (re-sign-in as the same
        // user keeps the work); signIn closes it if a different user signs in.
        if let id = user?.id { lastUserId = id }
        client.token = nil
        UserDefaults.standard.removeObject(forKey: "token")
        user = nil; projects = []; commits = []; state = nil; catchup = nil
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
    private var lastUserId: String?
    private var pendingRefresh: (force: Bool, queued: Bool) = (false, false)

    /// Commits + state on every tick. Catch-up (which may call the AI on the
    /// server) only when the project's sequence moved, or when forced.
    /// Calls arriving mid-flight are coalesced into one follow-up refresh.
    func refresh(forceCatchup: Bool = false) async {
        guard isSignedIn, projectId != nil else { return }
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
        guard let pid = projectId, let through = catchup?.throughSequence else { return }
        do {
            _ = try await client.seen(project: pid, through: through)
            await refresh(forceCatchup: true)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func image(path: String) async -> NSImage? {
        if let cached = imageCache[path] { return cached }
        guard let data = try? await client.imageData(path: path), let img = NSImage(data: data) else { return nil }
        imageCache[path] = img
        return img
    }

    // MARK: Capture

    /// Hotkey / panel entry point: system region picker → composer window.
    func startCapture() {
        guard !capturing, !isPreview else { return }
        if ComposerController.shared.isOpen {
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
                }
                return
            }
        }
        let front = NSWorkspace.shared.frontmostApplication
        let app = (front?.processIdentifier == getpid()) ? (lastExternalApp ?? Capture.topmostOtherApp()) : front
        let source = Capture.source(for: app)
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
                ComposerController.shared.open(image: image, png: png, source: source, app: self)
            }
        }
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
