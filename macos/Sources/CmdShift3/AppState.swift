import AppKit
import SwiftUI

enum MainTab: String, Hashable {
    case catchup, feed, state
}

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    static let defaultEndpoint = "http://127.0.0.1:4317"

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

        if client.token != nil { Task { await restore() } }
    }

    var currentProject: Project? { projects.first { $0.id == projectId } }
    var unseenCount: Int { catchup?.commits.count ?? 0 }
    var isSignedIn: Bool { user != nil }

    // MARK: Session

    func signIn(code: String) async {
        signingIn = true
        defer { signingIn = false }
        do {
            let s = try await client.session(code: code.trimmingCharacters(in: .whitespaces))
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
        } catch {
            lastError = error.localizedDescription
        }
    }

    func signOut() async {
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

    func refresh() async {
        guard isSignedIn, let pid = projectId else { return }
        do {
            async let c = client.commits(project: pid)
            async let s = client.state(project: pid)
            async let u = client.catchup(project: pid)
            let (cr, sr, ur) = try await (c, s, u)
            guard pid == projectId else { return }
            commits = cr.commits
            state = sr.state
            catchup = ur
            lastError = nil
        } catch let e as APIError where e.status == 401 {
            clearSession()
            lastError = "Session expired — sign in again."
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markSeen() async {
        guard let pid = projectId, let through = catchup?.throughSequence else { return }
        do {
            _ = try await client.seen(project: pid, through: through)
            await refresh()
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
        guard !capturing else { return }
        guard isSignedIn, projectId != nil else {
            lastError = "Sign in from the menu bar before committing."
            return
        }
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            showScreenRecordingAlert()
            return
        }
        let front = NSWorkspace.shared.frontmostApplication
        let app = (front?.processIdentifier == getpid()) ? lastExternalApp : front
        let source = Capture.source(for: app)
        capturing = true
        // Close the menu bar panel so it is not in the screenshot.
        for w in NSApp.windows where w.isVisible && w.className.contains("MenuBarExtra") { w.orderOut(nil) }
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
