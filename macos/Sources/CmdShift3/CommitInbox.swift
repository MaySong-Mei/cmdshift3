import SwiftUI

/// Commit tab: every capture that hasn't been committed yet, saved on this Mac.
/// Nothing here is published until its own Commit succeeds.
struct CommitInboxView: View {
    @EnvironmentObject var app: AppState
    @State private var thumbs: [String: NSImage] = [:]

    var body: some View {
        let drafts = app.inboxForProject
        let elsewhere = app.inbox.count - drafts.count
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Commit").font(.title2.bold())
                        Text("Captures waiting for your review. They're saved on this Mac and only published when you Commit.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { app.importScreenshot() } label: { Label("Import Screenshot…", systemImage: "square.and.arrow.down") }
                        .help("Add an existing screenshot file to this inbox")
                    Button { app.startCapture() } label: { Label("New capture", systemImage: "camera.viewfinder") }
                        .buttonStyle(.borderedProminent)
                        .help("Capture a region (\(HotKey.displayString))")
                }
                ForEach([app.captureProblem, app.hotKeyProblem].compactMap { $0 }, id: \.self) { problem in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(problem).fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        if problem.contains("Screen Recording") {
                            Button("Open System Settings") {
                                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                        }
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.12)))
                }
                if drafts.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No captures waiting.").font(.headline)
                        Text("Press \(HotKey.displayString) (Control–Shift–Command–2) anywhere, or use New capture. macOS's own ⌘⇧3 / ⌘⇧4 screenshots don't go to CmdShift3 — use Import Screenshot… for those.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 20)
                }
                ForEach(drafts) { d in row(d) }
                if elsewhere > 0 {
                    Text("\(elsewhere) more capture\(elsewhere == 1 ? "" : "s") waiting in other projects — switch project to see \(elsewhere == 1 ? "it" : "them").")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(20)
            .frame(maxWidth: 860, alignment: .leading)
        }
        .onAppear { app.reloadInbox() }
    }

    private func row(_ d: StoredDraft) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Group {
                if let img = thumbs[d.id] {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Rectangle().fill(Color.secondary.opacity(0.1))
                        .task { if let png = app.draftStore?.png(for: d), let img = NSImage(data: png) { thumbs[d.id] = img } }
                }
            }
            .frame(width: 112, height: 70)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))

            VStack(alignment: .leading, spacing: 3) {
                Text(d.title).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    Text(d.statusLabel).font(.caption.weight(.semibold))
                        .foregroundStyle(d.frozen != nil || d.aiFailure != nil ? Color.orange : Color.accentColor)
                    Text("· \(app.projects.first { $0.id == d.projectId }?.name ?? d.projectId)")
                    Text("· \(d.source.appName)")
                    Text("· \(relativeTime(d.updatedAt))")
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Discard…") { app.discardDraft(d) }
                .disabled(ComposerController.shared.openDraftId == d.id)
                .help("Delete this capture from this Mac (asks first)")
            Button(ComposerController.shared.openDraftId == d.id ? "Show" : "Open") { app.resumeDraft(d) }
                .buttonStyle(.borderedProminent)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.06)))
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { app.resumeDraft(d) }
    }
}
