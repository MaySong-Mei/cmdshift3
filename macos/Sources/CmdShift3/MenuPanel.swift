import SwiftUI

struct MenuPanel: View {
    @EnvironmentObject var app: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if app.isSignedIn { signedIn } else { signIn }
            if let e = app.lastError {
                Text(e).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 340)
    }

    // MARK: Signed out

    private var signIn: some View { SignInForm() }

    // MARK: Signed in

    private var signedIn: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "person.crop.circle.fill").foregroundStyle(.secondary)
                Text(app.user?.name ?? "").font(.headline)
                Spacer()
                Picker("", selection: Binding(get: { app.projectId ?? "" }, set: { app.projectId = $0 })) {
                    ForEach(app.projects) { p in Text(p.name).tag(p.id) }
                }
                .labelsHidden()
                .frame(maxWidth: 170)
            }

            Button { app.startCapture() } label: {
                HStack {
                    Image(systemName: "camera.viewfinder")
                    Text("New Work Commit")
                    Spacer()
                    Text(HotKey.displayString).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(app.capturing)

            if let p = app.captureProblem ?? app.hotKeyProblem {
                Label(p, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !app.inboxForProject.isEmpty {
                Button { open(.commit) } label: {
                    HStack {
                        Image(systemName: "tray.and.arrow.up")
                        Text("\(app.inboxForProject.count) capture\(app.inboxForProject.count == 1 ? "" : "s") waiting to commit")
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                }
                .buttonStyle(.bordered)
            }
            if app.unseenCount > 0 {
                Button { open(.catchup) } label: {
                    HStack {
                        Image(systemName: "sparkles")
                        Text("\(app.unseenCount) new commit\(app.unseenCount == 1 ? "" : "s") — Catch me up")
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                }
                .buttonStyle(.bordered)
            } else {
                Label("You're caught up", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
            }

            if !app.commits.isEmpty {
                Text("RECENT").font(.caption.bold()).foregroundStyle(.secondary)
                ForEach(app.commits.prefix(5)) { c in
                    Button {
                        app.selectedCommitId = c.id
                        open(.feed)
                    } label: { CommitRow(commit: c) }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var footer: some View {
        HStack {
            if app.isSignedIn {
                Button("Open CmdShift3") { open(app.unseenCount > 0 ? .catchup : .feed) }
                Button("Web") {
                    if let url = URL(string: app.endpoint) { NSWorkspace.shared.open(url) }
                }
                .help("Open the web dashboard")
            }
            Spacer()
            if app.isSignedIn {
                Menu {
                    Button("Sign out") { Task { await app.signOut() } }
                    Button("Quit CmdShift3") { NSApp.terminate(nil) }
                } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize()
            } else {
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .buttonStyle(.borderless)
        .font(.callout)
    }

    private func open(_ tab: MainTab) {
        app.mainTab = tab
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// Shared by the menu bar panel and the first-launch welcome window.
struct SignInForm: View {
    @EnvironmentObject var app: AppState
    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CmdShift3").font(.headline)
            Text("Commit your work. Everyone stays caught up.").font(.caption).foregroundStyle(.secondary)
            TextField("Server", text: $app.endpoint).textFieldStyle(.roundedBorder)
            HStack {
                SecureField(app.isLocalEndpoint ? "Login code" : "Personal Mac code", text: $code).textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await app.signIn(code: code) } }
                Button("Sign in") { Task { await app.signIn(code: code) } }
                    .disabled(code.isEmpty || app.signingIn)
            }
            if app.isLocalEndpoint {
                Text("Local demo codes: may-demo, gary-demo").font(.caption2).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Text("Get your personal code on the web:").font(.caption2).foregroundStyle(.secondary)
                    Button("Connect Mac app ↗") {
                        if let url = URL(string: app.endpoint) { NSWorkspace.shared.open(url) }
                    }
                    .buttonStyle(.link)
                    .font(.caption2)
                }
            }
        }
    }
}

struct CommitRow: View {
    let commit: WorkCommit

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(commit.summary ?? commit.comment ?? "Work commit").lineLimit(2).font(.callout)
            HStack(spacing: 6) {
                Text(commit.author?.name ?? "")
                Text(relativeTime(commit.date))
                if let sha = commit.shortSha { Text(sha).font(.caption2.monospaced()) }
                if let app = commit.source?.appName, !app.isEmpty { Text("· \(app)") }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
