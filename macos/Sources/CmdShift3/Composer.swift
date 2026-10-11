import AppKit
import SwiftUI

/// An open blocker / next item a shipped item can explicitly resolve.
struct OpenItem: Identifiable, Hashable {
    let item: StateItem
    let kind: String
    var id: String { item.id }
}

@MainActor
final class ComposerModel: ObservableObject {
    /// Generated once per composer and reused on retry (API v1 idempotency).
    private(set) var commitId = "wc_" + UUID().uuidString.lowercased()
    /// Frozen on first submit so a retry resends exactly the same payload.
    @Published private(set) var frozen: CommitRequest?
    var isLocked: Bool { frozen != nil }
    let image: NSImage
    let png: Data
    let source: Source

    @Published var projectId: String
    @Published var annotations: [Annotation] = []
    @Published var comment = ""
    @Published var summary = ""
    @Published var fields = Fields()
    @Published var organizer: Provider?
    @Published var warnings: [String] = []
    @Published var openItems: [OpenItem] = []
    @Published var drafting = false
    @Published var committing = false
    @Published var error: String?
    @Published var result: WorkCommit?

    init(image: NSImage, png: Data, source: Source, projectId: String) {
        self.image = image
        self.png = png
        self.source = source
        self.projectId = projectId
    }

    func loadOpenItems(_ app: AppState) async {
        let pid = projectId
        guard let s = try? await app.client.state(project: pid).state else { if pid == projectId { openItems = [] }; return }
        guard pid == projectId else { return }
        openItems = s.blockers.map { OpenItem(item: $0, kind: "BLOCKER") } + s.next.map { OpenItem(item: $0, kind: "NEXT") }
    }

    /// Resolves references are project-scoped, so they cannot follow a project switch.
    func projectChanged(_ app: AppState) async {
        for i in fields.shipped.indices { fields.shipped[i].resolves = nil }
        organizer = nil
        warnings = []
        openItems = []
        await loadOpenItems(app)
    }

    func draft(_ app: AppState) async {
        let pid = projectId
        drafting = true
        error = nil
        defer { drafting = false }
        do {
            let r = try await app.client.draft(DraftRequest(projectId: pid, comment: comment, source: source,
                                                            imageBase64: png.base64EncodedString()))
            guard pid == projectId, !isLocked else { return }
            // Merge, never overwrite what the user already typed or linked.
            if let f = r.fields {
                if fields.cleaned().isEmpty {
                    fields = f
                } else {
                    for kind in FieldKind.allCases {
                        let have = Set(fields[keyPath: kind.keyPath].map { $0.text.lowercased() })
                        fields[keyPath: kind.keyPath] += f[keyPath: kind.keyPath].filter { !have.contains($0.text.lowercased()) }
                    }
                }
            }
            if let s = r.summary, !s.isEmpty, summary.trimmingCharacters(in: .whitespaces).isEmpty { summary = s }
            organizer = r.organizer
            warnings = r.warnings ?? []
        } catch {
            self.error = error.localizedDescription
        }
    }

    var effectiveSummary: String {
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty { return s }
        if let first = fields.cleaned().shipped.first?.text { return first }
        let line = comment.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? "Work update from \(source.appName)" : String(line.prefix(140))
    }

    func commit(_ app: AppState) async {
        committing = true
        error = nil
        defer { committing = false }
        let req = frozen ?? CommitRequest(id: commitId, projectId: projectId, source: source,
                                          imageBase64: png.base64EncodedString(), annotations: annotations,
                                          comment: comment, summary: effectiveSummary, fields: fields.cleaned())
        frozen = req
        do {
            result = try await app.client.commit(req)
            await app.refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Explicitly abandons the frozen attempt: unlocks editing under a fresh id.
    /// If the earlier attempt did reach the server, that becomes a separate commit.
    func editAsNew() {
        frozen = nil
        commitId = "wc_" + UUID().uuidString.lowercased()
        // Item ids are globally unique on the server: if the frozen attempt did
        // land, reusing them would 409 (item_id_conflict). Keep text and resolves.
        for kind in FieldKind.allCases {
            fields[keyPath: kind.keyPath] = fields[keyPath: kind.keyPath].map {
                FieldItem(id: "it_" + UUID().uuidString.lowercased(), text: $0.text, resolves: $0.resolves)
            }
        }
        error = nil
    }
}

@MainActor
final class ComposerController: NSObject, NSWindowDelegate {
    static let shared = ComposerController()
    private var window: NSWindow?

    /// A composer is open: new captures must not silently replace its work.
    var isOpen: Bool { window?.isVisible == true }

    func bringToFront() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Used on sign-out so a draft cannot be committed under the next user.
    func closeAll() { window?.close() }

    func open(image: NSImage, png: Data, source: Source, app: AppState) {
        guard !isOpen else { bringToFront(); return }
        guard let pid = app.projectId else { return }
        let model = ComposerModel(image: image, png: png, source: source, projectId: pid)
        // Each composer closes only its own window, never a newer one.
        weak var own: NSWindow?
        let view = ComposerView(model: model, close: { own?.close() })
            .environmentObject(app)
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1180, visible.width - 40), height: min(760, visible.height - 40))
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "New Work Commit — \(source.appName)"
        w.contentViewController = NSHostingController(rootView: view)
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.delegate = self
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        own = w
        window = w
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === window { window = nil }
    }
}

struct ComposerView: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let close: () -> Void

    @State private var tool: AnnotationType = .rect
    @State private var color = annotationColors[0]
    @State private var labelText = ""

    var body: some View {
        HStack(spacing: 0) {
            canvasPane.disabled(model.isLocked)
            Divider()
            formPane.frame(width: 400)
        }
        .frame(minWidth: 880, minHeight: 560)
        .task { await model.loadOpenItems(app) }
    }

    // MARK: Left: screenshot + annotation tools

    private var canvasPane: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Picker("Tool", selection: $tool) {
                    ForEach(AnnotationType.allCases) { t in
                        Label(t.label, systemImage: t.symbol).tag(t)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 320)

                HStack(spacing: 6) {
                    ForEach(annotationColors, id: \.self) { c in
                        Circle().fill(Color(hex: c)).frame(width: 18, height: 18)
                            .overlay(Circle().stroke(Color.primary, lineWidth: c == color ? 2 : 0))
                            .onTapGesture { color = c }
                    }
                }
                if tool == .text {
                    TextField("Label text, then click the image", text: $labelText)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 220)
                }
                Spacer()
                Button { _ = model.annotations.popLast() } label: { Image(systemName: "arrow.uturn.backward") }
                    .help("Undo last annotation").disabled(model.annotations.isEmpty)
                Button("Clear") { model.annotations.removeAll() }.disabled(model.annotations.isEmpty)
            }
            AnnotationCanvas(image: model.image, annotations: $model.annotations, tool: tool, color: color, text: labelText)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            HStack {
                Image(systemName: "app.badge").foregroundStyle(.secondary)
                Text(model.source.windowTitle.isEmpty ? model.source.appName : "\(model.source.appName) — \(model.source.windowTitle)")
                    .foregroundStyle(.secondary).lineLimit(1)
                Spacer()
            }
            .font(.caption)
        }
        .padding(14)
    }

    // MARK: Right: comment, draft, fields, commit

    private var formPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    formFields.disabled(model.isLocked)
                }
                .padding(16)
            }
            Divider()
            footer.padding(14)
        }
    }

    @ViewBuilder
    private var formFields: some View {
                    if app.projects.count > 1 {
                        Picker("Project", selection: $model.projectId) {
                            ForEach(app.projects) { p in Text(p.name).tag(p.id) }
                        }
                        .onChange(of: model.projectId) { Task { await model.projectChanged(app) } }
                    } else if let p = app.currentProject {
                        Label(p.name, systemImage: "folder").font(.subheadline.weight(.medium))
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("What changed?").font(.headline)
                        TextEditor(text: $model.comment)
                            .font(.body)
                            .frame(minHeight: 70, maxHeight: 110)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                        HStack {
                            Button {
                                Task { await model.draft(app) }
                            } label: {
                                if model.drafting { ProgressView().controlSize(.small) } else { Label("Draft fields", systemImage: "wand.and.stars") }
                            }
                            .disabled(model.drafting || model.comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .keyboardShortcut("d", modifiers: .command)
                            Spacer()
                            organizerBadge
                        }
                        ForEach(model.warnings, id: \.self) { w in
                            Label(w, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("SUMMARY").font(.caption.bold()).foregroundStyle(.secondary)
                        TextField(model.effectiveSummary, text: $model.summary).textFieldStyle(.roundedBorder)
                    }

                    ForEach(FieldKind.allCases) { kind in fieldSection(kind) }
    }

    @ViewBuilder
    private var organizerBadge: some View {
        if let o = model.organizer {
            if o.isManual {
                Label("Manual — no AI connected", systemImage: "hand.raised")
                    .font(.caption).foregroundStyle(.secondary)
                    .help("The server has no AI provider configured. Fields are what you confirm here.")
            } else {
                Label(o.provider ?? "AI", systemImage: "sparkles").font(.caption).foregroundStyle(.purple)
            }
        }
    }

    private func fieldSection(_ kind: FieldKind) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(kind.title).font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                Button { model.fields[keyPath: kind.keyPath].append(.new()) } label: { Image(systemName: "plus.circle") }
                    .buttonStyle(.borderless).help("Add \(kind.rawValue)")
            }
            ForEach($model.fields[dynamicMember: kind.keyPath]) { $item in
                HStack(spacing: 6) {
                    TextField(kind.placeholder, text: $item.text).textFieldStyle(.roundedBorder)
                    if kind == .shipped { resolvesMenu($item) }
                    Button {
                        let id = item.id
                        model.fields[keyPath: kind.keyPath].removeAll { $0.id == id }
                    } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func resolvesMenu(_ item: Binding<FieldItem>) -> some View {
        let selected = item.wrappedValue.resolves ?? []
        return Menu {
            if model.openItems.isEmpty {
                Text("No open blockers or next items")
            }
            ForEach(model.openItems) { o in
                Toggle("\(o.kind) · \(o.item.text)", isOn: Binding(
                    get: { (item.wrappedValue.resolves ?? []).contains(o.id) },
                    set: { on in
                        var r = item.wrappedValue.resolves ?? []
                        if on { if !r.contains(o.id) { r.append(o.id) } } else { r.removeAll { $0 == o.id } }
                        item.wrappedValue.resolves = r
                    }
                ))
            }
        } label: {
            Label(selected.isEmpty ? "Resolves…" : "Resolves \(selected.count)", systemImage: "checkmark.seal")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Explicitly mark an open blocker / next item as resolved by this")
    }

    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let e = model.error {
                Label(e, systemImage: "xmark.octagon").font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if model.isLocked && model.result == nil && !model.committing {
                Text("Retry resends exactly what was submitted. To change it, start a new commit.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let r = model.result {
                Label("Committed \(r.shortSha ?? "") · #\(r.sequence ?? 0)\(r.git?.remoteSynced == false ? " · origin not synced yet" : "")",
                      systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            HStack {
                Button("Cancel", role: .cancel, action: close).keyboardShortcut(.cancelAction)
                Spacer()
                if model.isLocked && model.result == nil && !model.committing {
                    Button("Edit as new commit") { model.editAsNew() }
                }
                if model.result != nil {
                    Button("Done", action: close).keyboardShortcut(.defaultAction)
                } else {
                    Button {
                        Task {
                            await model.commit(app)
                            if model.result != nil {
                                try? await Task.sleep(for: .seconds(1.2))
                                close()
                            }
                        }
                    } label: {
                        if model.committing { ProgressView().controlSize(.small) } else { Text(model.isLocked ? "Retry  ⌘↩" : "Commit  ⌘↩") }
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(model.committing)
                }
            }
        }
    }
}
