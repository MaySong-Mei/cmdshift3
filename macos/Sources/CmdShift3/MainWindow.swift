import SwiftUI

struct MainView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { app.mainTab }, set: { if let t = $0 { app.mainTab = t } })) {
                Label("Commit", systemImage: "tray.and.arrow.up")
                    .badge(app.inboxForProject.count)
                    .tag(MainTab.commit)
                Label("Catch me up", systemImage: "sparkles")
                    .badge(app.unseenCount)
                    .tag(MainTab.catchup)
                Section("Work") {
                    Label("Work", systemImage: "list.bullet.rectangle").tag(MainTab.feed)
                    Label("Progress", systemImage: "point.3.connected.trianglepath.dotted").tag(MainTab.progress)
                    Label("People", systemImage: "person.2").tag(MainTab.people)
                    Label("Project state", systemImage: "square.stack.3d.up").tag(MainTab.state)
                }
                Section("Ask") {
                    Label("Ask", systemImage: "bubble.left.and.text.bubble.right").tag(MainTab.ask)
                }
            }
            .navigationSplitViewColumnWidth(200)
        } detail: {
            Group {
                if !app.isSignedIn {
                    WelcomeView()
                } else {
                    switch app.mainTab {
                    case .commit: CommitInboxView()
                    case .catchup: CatchupView()
                    case .feed: FeedView()
                    case .progress: ProjectProgressView()
                    case .people: PeopleView()
                    case .state: StateView()
                    case .ask: AskView()
                    }
                }
            }
            .navigationTitle(app.currentProject?.name ?? "CmdShift3")
            .toolbar {
                if app.isSignedIn {
                    ToolbarItem(placement: .navigation) {
                        // Same project switch as the menu bar panel (AppState.projectId).
                        Picker(selection: Binding(get: { app.projectId ?? "" }, set: { app.projectId = $0 })) {
                            ForEach(app.projects) { p in Text(p.name).tag(p.id) }
                        } label: {
                            Label("Project", systemImage: "folder")
                        }
                        .help("Switch project")
                        .disabled(app.projects.count < 2)
                    }
                    ToolbarItem {
                        Menu {
                            Text("Signed in as \(app.user?.name ?? "")")
                            Text(app.endpoint).font(.caption)
                            if let e = app.lastError { Text(e) }
                            Divider()
                            // Existing guarded sign-out (refuses while a commit is in flight).
                            Button("Sign out") { Task { await app.signOut() } }
                        } label: {
                            Label(app.user?.name ?? "Account", systemImage: "person.crop.circle")
                        }
                        .help("Account")
                    }
                }
                ToolbarItem {
                    Button { app.startCapture() } label: { Label("New Work Commit", systemImage: "camera.viewfinder") }
                        .help("New Work Commit (\(HotKey.displayString))")
                }
                ToolbarItem {
                    Button { Task { await app.refresh(forceCatchup: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                }
            }
        }
        .task { await app.refresh(forceCatchup: true) }
    }
}

// MARK: Catch me up

struct CatchupView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let c = app.catchup {
                    HStack(alignment: .firstTextBaseline) {
                        Text(c.commits.isEmpty ? "You're caught up" : "\(c.commits.count) new since you last looked")
                            .font(.title2.bold())
                        Spacer()
                        if let a = c.analyzer {
                            Label(a.mode == .notConfigured ? "Factual summary — no AI connected"
                                    : a.mode == .unavailable ? "Factual summary — AI unavailable right now" : (a.provider ?? "AI"),
                                  systemImage: a.mode == .ai ? "sparkles" : "list.bullet.clipboard")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let s = c.summary, !s.isEmpty {
                        Text(s).textSelection(.enabled)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.08)))
                    }
                    if let state = c.state ?? app.state, !state.blockers.isEmpty {
                        StateSection(title: "Open blockers", items: state.blockers, tint: .red)
                    }
                    ForEach(c.commits) { commit in
                        CommitCard(commit: commit)
                            .onTapGesture {
                                app.selectedCommitId = commit.id
                                app.mainTab = .feed
                            }
                    }
                    if !c.commits.isEmpty {
                        Button {
                            Task { await app.markSeen() }
                        } label: {
                            Label("Mark as seen through #\(c.throughSequence ?? 0)", systemImage: "checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    ProgressView()
                }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
        }
    }
}

// MARK: Feed

struct FeedView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        HSplitView {
            List(app.commits, selection: $app.selectedCommitId) { c in
                CommitRow(commit: c).padding(.vertical, 4).tag(c.id)
            }
            .frame(minWidth: 260, idealWidth: 300, maxWidth: 380)

            if let id = app.selectedCommitId, let c = app.commits.first(where: { $0.id == id }) {
                CommitDetailView(commit: c).id(c.id)
            } else {
                ContentUnavailableView(app.commits.isEmpty ? "No commits yet" : "Select a commit",
                                       systemImage: "camera.viewfinder",
                                       description: Text("Press \(HotKey.displayString) anywhere to commit your work."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct CommitCard: View {
    let commit: WorkCommit

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CommitRow(commit: commit)
            FieldsView(fields: commit.fields ?? Fields())
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
        .contentShape(Rectangle())
    }
}

struct FieldsView: View {
    let fields: Fields

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(FieldKind.allCases) { kind in
                let items = fields[keyPath: kind.keyPath]
                if !items.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(kind.title).font(.caption2.bold()).foregroundStyle(color(kind))
                        ForEach(items) { item in
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text("•")
                                Text(item.text).textSelection(.enabled)
                                if let r = item.resolves, !r.isEmpty {
                                    Text("resolves \(r.count)").font(.caption2).foregroundStyle(.green)
                                }
                            }
                            .font(.callout)
                        }
                    }
                }
            }
        }
    }

    private func color(_ kind: FieldKind) -> Color {
        switch kind {
        case .shipped: return .green
        case .decision: return .blue
        case .why: return .secondary
        case .blocker: return .red
        case .next: return .orange
        }
    }
}

struct CommitDetailView: View {
    @EnvironmentObject var app: AppState
    let commit: WorkCommit
    @State private var image: NSImage?
    @State private var comments: [Comment] = []
    @State private var draft = ""
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(commit.summary ?? "Work commit").font(.title3.bold()).textSelection(.enabled)
                HStack(spacing: 8) {
                    Text(commit.author?.name ?? "")
                    Text(relativeTime(commit.date))
                    if let s = commit.source { Text("· \(s.appName)\(s.windowTitle.isEmpty ? "" : " — \(s.windowTitle)")").lineLimit(1) }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let sha = commit.git?.sha {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.branch")
                        Text(sha).font(.caption.monospaced()).textSelection(.enabled)
                        Text(commit.git?.remoteSynced == true ? "synced to origin" : "not yet synced")
                            .foregroundStyle(commit.git?.remoteSynced == true ? .green : .orange)
                    }
                    .font(.caption)
                }
                if let image {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                        .overlay(AnnotationLayer(annotations: commit.evidence?.annotations ?? []))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .frame(maxHeight: 460)
                } else if commit.evidence?.imageUrl != nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                }
                if let c = commit.comment, !c.isEmpty {
                    Text("“\(c)”").italic().foregroundStyle(.secondary).textSelection(.enabled)
                }
                FieldsView(fields: commit.fields ?? Fields())

                Divider()
                Text("Discussion").font(.headline)
                ForEach(comments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(c.author?.name ?? "").font(.caption.bold())
                            Text(relativeTime(c.createdAt.flatMap(parseISODate))).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(c.body).textSelection(.enabled)
                    }
                }
                HStack {
                    TextField("Add a comment", text: $draft).textFieldStyle(.roundedBorder)
                        .onSubmit(send)
                    Button("Send", action: send).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            .padding(20)
        }
        .task {
            if let path = commit.evidence?.imageUrl { image = await app.image(path: path) }
            // Poll while the detail is visible; .task cancels this on disappear.
            while !Task.isCancelled {
                if let latest = try? await app.client.comments(commit: commit.id) { comments = latest }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        Task {
            do {
                let c = try await app.client.addComment(commit: commit.id, body: body)
                if !comments.contains(where: { $0.id == c.id }) { comments.append(c) }
                draft = ""
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: Project state

struct StateView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let s = app.state {
                    StateSection(title: "Blockers", items: s.blockers, tint: .red)
                    StateSection(title: "Next", items: s.next, tint: .orange)
                    StateSection(title: "Decisions", items: s.decisions, tint: .blue)
                    StateSection(title: "Shipped", items: s.shipped, tint: .green)
                } else {
                    ProgressView()
                }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
        }
    }
}

struct StateSection: View {
    let title: String
    let items: [StateItem]
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(title.uppercased()) · \(items.count)").font(.caption.bold()).foregroundStyle(tint)
            if items.isEmpty {
                Text("None").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.text).textSelection(.enabled)
                    Spacer()
                    Text([item.author?.name, item.gitSha.map { String($0.prefix(7)) }].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: First launch

struct WelcomeView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "camera.viewfinder").font(.system(size: 40)).foregroundStyle(.tint)
            SignInForm()
            if let e = app.lastError {
                Text(e).font(.caption).foregroundStyle(.red)
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Label("CmdShift3 lives in the menu bar (camera icon, top right).", systemImage: "menubar.rectangle")
                Label("Press \(HotKey.displayString) anywhere to commit what is on screen.", systemImage: "keyboard")
                Label("First capture asks for Screen Recording permission.", systemImage: "lock.shield")
            }
            .font(.callout).foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(maxWidth: 440)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
