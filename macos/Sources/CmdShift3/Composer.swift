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
    /// `--preview-capture`: layout review only — no network, no Draft/Commit.
    let isPreview: Bool

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
    /// AI fields stay folded until the user drafts (or adds one by hand).
    @Published var fieldsExpanded = false
    /// What the last draft inserted (item id → text, and summary), so a
    /// re-draft can replace it without touching the user's own edits.
    private var drafted: [String: String] = [:]
    private var draftedSummary: String?

    init(image: NSImage, png: Data, source: Source, projectId: String, isPreview: Bool = false) {
        self.image = image
        self.png = png
        self.source = source
        self.projectId = projectId
        self.isPreview = isPreview
    }

    /// Unsent work that closing the window would throw away.
    var isDirty: Bool {
        guard result == nil else { return false }
        return !annotations.isEmpty
            || !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !fields.cleaned().isEmpty
    }

    var fieldCount: Int { FieldKind.allCases.reduce(0) { $0 + fields[keyPath: $1.keyPath].count } }

    func loadOpenItems(_ app: AppState) async {
        guard !isPreview else { return }
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
        guard !isPreview else { return }
        let pid = projectId
        drafting = true
        error = nil
        defer { drafting = false }
        do {
            let r = try await app.client.draft(DraftRequest(projectId: pid, comment: comment, source: source,
                                                            imageBase64: png.base64EncodedString()))
            guard pid == projectId, !isLocked else { return }
            // Re-drafting replaces the previous draft's untouched items, but keeps
            // anything the user typed or edited (and any resolves they linked).
            if let f = r.fields {
                for kind in FieldKind.allCases {
                    let kept = fields[keyPath: kind.keyPath].filter { item in
                        guard let original = drafted[item.id] else { return true }
                        return item.text != original || !(item.resolves ?? []).isEmpty
                    }
                    let have = Set(kept.map { $0.text.lowercased() })
                    fields[keyPath: kind.keyPath] = kept + f[keyPath: kind.keyPath].filter { !have.contains($0.text.lowercased()) }
                }
                drafted = [:]
                for kind in FieldKind.allCases {
                    for item in f[keyPath: kind.keyPath] { drafted[item.id] = item.text }
                }
            }
            if let s = r.summary, !s.isEmpty {
                let current = summary.trimmingCharacters(in: .whitespaces)
                if current.isEmpty || current == draftedSummary { summary = s }
                draftedSummary = s
            }
            organizer = r.organizer
            warnings = r.warnings ?? []
            fieldsExpanded = true
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
        guard !isPreview else { return }
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
    private var model: ComposerModel?
    /// Set once the user confirmed discarding (or the commit succeeded).
    private var allowClose = false

    /// A composer is open: new captures must not silently replace its work.
    /// windowWillClose clears `window`, so this also covers a minimized composer.
    var isOpen: Bool { window != nil }

    func bringToFront() {
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Used on sign-out so a draft cannot be committed under the next user.
    func closeAll() { forceClose() }

    /// Cancel / Esc / ✕ all go through windowShouldClose (dirty check).
    func requestClose() { window?.performClose(nil) }

    func forceClose() {
        allowClose = true
        window?.close()
    }

    func open(image: NSImage, png: Data, source: Source, app: AppState, preview: Bool = false) {
        guard !isOpen else { bringToFront(); return }
        guard let pid = preview ? (app.projectId ?? "preview") : app.projectId else { return }
        let model = ComposerModel(image: image, png: png, source: source, projectId: pid, isPreview: preview)
        let view = ComposerView(model: model,
                                requestClose: { [weak self] in self?.requestClose() },
                                finish: { [weak self] in self?.forceClose() })
            .environmentObject(app)
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1280, visible.width - 40), height: min(820, visible.height - 40))
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = preview ? "Work Commit — Preview" : "Work Commit — \(source.appName)"
        let host = NSHostingController(rootView: view)
        host.sizingOptions = [.minSize]
        w.contentViewController = host
        // Attaching the controller resizes to SwiftUI's ideal size; re-apply ours.
        w.setContentSize(size)
        w.isReleasedWhenClosed = false
        w.level = .floating
        w.delegate = self
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        allowClose = false
        self.model = model
        window = w
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window, let model, !allowClose else { return true }
        if model.committing {
            NSSound.beep()
            return false
        }
        guard model.isDirty else { return true }
        let alert = NSAlert()
        alert.messageText = "Discard this capture?"
        alert.informativeText = "Your marks and comment haven't been committed yet."
        alert.addButton(withTitle: "Keep Editing")
        alert.addButton(withTitle: "Discard")
        alert.buttons[1].hasDestructiveAction = true
        alert.beginSheetModal(for: sender) { [weak self] response in
            if response == .alertSecondButtonReturn { self?.forceClose() }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === window {
            window = nil
            model = nil
        }
    }
}

/// Tools in the order people reach for them.
private let toolOrder: [AnnotationType] = [.rect, .arrow, .highlight, .text]
private let colorNames = ["Coral", "Amber", "Green", "Blue", "Purple"]

struct ComposerView: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let requestClose: () -> Void
    let finish: () -> Void

    @State private var tool: AnnotationType = .rect
    @State private var color = annotationColors[0]
    @State private var labelText = ""
    @FocusState private var commentFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack(spacing: 0) {
                canvasPane.disabled(model.isLocked)
                Divider()
                sidebar.frame(width: 340)
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .task { await model.loadOpenItems(app) }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { commentFocused = true }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 12) {
            Label(model.isPreview ? "Preview" : "Captured", systemImage: model.isPreview ? "eye" : "checkmark.circle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(model.isPreview ? Color.orange : Color.green)
            Text(model.isPreview
                 ? "Layout preview from a fixture image — not a real capture. Draft and Commit are off."
                 : "Add a mark or tell your team what changed.")
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 12)
            projectControl
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var projectControl: some View {
        if app.projects.count > 1 {
            Picker(selection: $model.projectId) {
                ForEach(app.projects) { p in Text(p.name).tag(p.id) }
            } label: {
                Label("Project", systemImage: "folder")
            }
            .fixedSize()
            .disabled(model.isLocked)
            .onChange(of: model.projectId) { Task { await model.projectChanged(app) } }
            .help("The project this Work Commit goes to")
        } else {
            Label(app.currentProject?.name ?? (model.isPreview ? "Preview project" : "Project"), systemImage: "folder")
                .font(.callout.weight(.medium))
                .help("The project this Work Commit goes to")
        }
    }

    // MARK: Canvas

    private var canvasPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Picker("Tool", selection: $tool) {
                    ForEach(toolOrder) { t in
                        Label(t.label, systemImage: t.symbol).tag(t)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("Mark tool")

                HStack(spacing: 6) {
                    ForEach(Array(annotationColors.enumerated()), id: \.element) { i, c in
                        Button { color = c } label: {
                            Circle().fill(Color(hex: c)).frame(width: 18, height: 18)
                                .overlay(Circle().stroke(Color.primary, lineWidth: c == color ? 2 : 0).padding(-3))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(colorNames[i]) mark color")
                        .accessibilityAddTraits(c == color ? .isSelected : [])
                        .help("\(colorNames[i]) marks")
                    }
                }
                Spacer(minLength: 8)
                Button { _ = model.annotations.popLast() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                    .help("Undo the last mark").disabled(model.annotations.isEmpty)
                Button { model.annotations.removeAll() } label: { Label("Clear", systemImage: "trash") }
                    .help("Remove all marks").disabled(model.annotations.isEmpty)
            }
            if tool == .text {
                HStack(spacing: 8) {
                    TextField("Label text", text: $labelText)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 260)
                    Text("Type the label, then click where it goes.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            CaptureStage(image: model.image, annotations: $model.annotations, tool: tool, color: color, text: labelText)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 6) {
                Image(systemName: "app.badge").foregroundStyle(.secondary)
                Text(model.source.windowTitle.isEmpty ? model.source.appName : "\(model.source.appName) — \(model.source.windowTitle)")
                    .foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if model.annotations.isEmpty {
                    Text(tool == .text ? "Click the screenshot to place a label." : "Drag on the screenshot to add a \(tool.label.lowercased()).")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
        .padding(14)
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    commentBox.disabled(model.isLocked)
                    fieldsReview.disabled(model.isLocked)
                }
                .padding(16)
            }
            Divider()
            footer.padding(14)
        }
    }

    private var commentBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What changed?").font(.headline)
            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.comment)
                    .font(.body)
                    .focused($commentFocused)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                if model.comment.isEmpty {
                    Text("One sentence is enough — e.g. “Auth works now. Next: the handoff flow.”")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .allowsHitTesting(false)
                }
            }
            .frame(minHeight: 110, maxHeight: 180)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(commentFocused ? Color.accentColor : Color.secondary.opacity(0.3),
                                                               lineWidth: commentFocused ? 2 : 1))
            HStack {
                Button {
                    Task { await model.draft(app) }
                } label: {
                    if model.drafting {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Drafting…") }
                    } else {
                        Label("Draft with AI", systemImage: "wand.and.stars")
                    }
                }
                .disabled(model.isPreview || model.drafting || model.comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut("d", modifiers: .command)
                .help(model.isPreview ? "Off in preview" : "Turn your screenshot and sentence into reviewable fields (⌘D)")
                Spacer()
                organizerBadge
            }
            Text("Return adds a new line. Nothing is sent until you press Commit.")
                .font(.caption2).foregroundStyle(.secondary)
            ForEach(model.warnings, id: \.self) { w in
                Label(w, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var organizerBadge: some View {
        if let o = model.organizer {
            switch o.mode {
            case .notConfigured:
                Label("Manual — no AI connected", systemImage: "hand.raised")
                    .font(.caption).foregroundStyle(.secondary)
                    .help("The server has no AI provider configured. Fields are what you confirm here.")
            case .unavailable:
                Label("AI unavailable — review by hand", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .help("AI is configured but could not finish this draft. Your screenshot and comment are kept.")
            case .ai:
                Label(o.provider ?? "AI", systemImage: "sparkles").font(.caption).foregroundStyle(.purple)
            }
        }
    }

    private var fieldsReview: some View {
        DisclosureGroup(isExpanded: $model.fieldsExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("SUMMARY").font(.caption.bold()).foregroundStyle(.secondary)
                    TextField(model.effectiveSummary, text: $model.summary).textFieldStyle(.roundedBorder)
                }
                ForEach(FieldKind.allCases) { kind in fieldSection(kind) }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 6) {
                Text("Review details").font(.subheadline.weight(.semibold))
                if model.fieldCount > 0 {
                    Text("\(model.fieldCount)").font(.caption.monospacedDigit())
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
                Spacer()
                if !model.fieldsExpanded {
                    Text("Shipped · Decision · Why · Blocker · Next").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func fieldSection(_ kind: FieldKind) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(kind.title).font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                Button { model.fields[keyPath: kind.keyPath].append(.new()) } label: { Image(systemName: "plus.circle") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Add \(kind.rawValue)")
                    .help("Add \(kind.rawValue)")
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
                    .accessibilityLabel("Remove \(kind.rawValue) item")
                    .help("Remove")
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

    // MARK: Footer

    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let e = model.error {
                Label(e, systemImage: "xmark.octagon").font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.isLocked && model.result == nil && !model.committing {
                Text("Retry resends exactly what was submitted. To change it, start a new commit.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let r = model.result {
                CommittedBanner(commit: r)
            }
            HStack {
                Button("Cancel", role: .cancel, action: requestClose)
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.committing)
                Spacer()
                if model.isLocked && model.result == nil && !model.committing {
                    Button("Edit as new commit") { model.editAsNew() }
                }
                if model.result != nil {
                    Button("Done", action: finish).keyboardShortcut(.defaultAction)
                } else {
                    Button {
                        Task {
                            await model.commit(app)
                            if model.result != nil {
                                try? await Task.sleep(for: .seconds(1.6))
                                finish()
                            }
                        }
                    } label: {
                        if model.committing {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Committing…") }
                        } else {
                            Text(model.isLocked ? "Retry  ⌘↩" : "Commit  ⌘↩")
                        }
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isPreview || model.committing)
                    .help(model.isPreview ? "Off in preview" : "Create the Work Commit (⌘↩)")
                }
            }
        }
    }
}

/// Shown only after a real Commit response: SHA + origin sync.
private struct CommittedBanner: View {
    let commit: WorkCommit
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(.green)
                .scaleEffect(shown || reduceMotion ? 1 : 0.6)
            VStack(alignment: .leading, spacing: 1) {
                Text("Committed · #\(commit.sequence ?? 0)").font(.callout.weight(.semibold))
                Text("\(commit.shortSha ?? "")\(commit.git?.remoteSynced == false ? " · origin not synced yet" : " · synced")")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.green.opacity(0.12)))
        .onAppear {
            if reduceMotion { shown = true } else { withAnimation(.spring(duration: 0.35, bounce: 0.4)) { shown = true } }
        }
    }
}

/// The captured screenshot as the main stage: a soft fade/scale-in and one
/// accent border pulse on arrival (view-only — never burned into the PNG).
private struct CaptureStage: View {
    let image: NSImage
    @Binding var annotations: [Annotation]
    let tool: AnnotationType
    let color: String
    let text: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var pulse = 0.0

    var body: some View {
        AnnotationCanvas(image: image, annotations: $annotations, tool: tool, color: color, text: text)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(pulse), lineWidth: 3))
            .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
            .opacity(appeared ? 1 : 0)
            .scaleEffect(appeared || reduceMotion ? 1 : 0.97)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(4)
            .onAppear {
                if reduceMotion {
                    appeared = true
                    return
                }
                withAnimation(.easeOut(duration: 0.25)) { appeared = true }
                pulse = 0.9
                withAnimation(.easeOut(duration: 0.9).delay(0.15)) { pulse = 0 }
            }
    }
}
