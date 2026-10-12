import AppKit
import SwiftUI

/// Tools in the order people reach for them.
private let toolOrder: [AnnotationType] = [.rect, .arrow, .highlight, .text]
private let colorNames = ["Coral", "Amber", "Green", "Blue", "Purple"]

extension FieldKind {
    /// Reading labels for the review card.
    var heading: String {
        switch self {
        case .shipped: return "Shipped"
        case .decision: return "Decision"
        case .why: return "Why"
        case .blocker: return "Blocker"
        case .next: return "Next"
        }
    }
}

/// One window, one model: a light review card by default, the full canvas +
/// draft editor when the person asks for it.
struct ComposerView: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let requestClose: () -> Void
    let finish: () -> Void

    var body: some View {
        Group {
            switch model.mode {
            case .card: CaptureCard(model: model, requestClose: requestClose, finish: finish)
            case .editor: CaptureEditor(model: model, requestClose: requestClose, finish: finish)
            }
        }
        .background(Theme.surface)
        .onChange(of: model.projectId) { Task { await model.projectChanged(app.client) } }
    }
}

// MARK: - Card

private struct CaptureCard: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let requestClose: () -> Void
    let finish: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ComposerHeader(model: model)
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    thumbnail
                    AssistantDraft(model: model)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
            ContextInput(model: model, compact: true)
                .padding(.horizontal, 20)
                .padding(.top, 10)
            ComposerFooter(model: model, requestClose: requestClose, finish: finish)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
        }
        .frame(minWidth: 600, minHeight: 540)
    }

    private var thumbnail: some View {
        HStack {
            Spacer(minLength: 0)
            Image(nsImage: model.image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .overlay(AnnotationLayer(annotations: model.annotations))
                .modifier(CaptureHighlight(animateArrival: !model.arrivalPulsed) { model.arrivalPulsed = true })
                .frame(maxHeight: 250)
                .overlay(alignment: .bottomTrailing) {
                    Button { model.editorFocusesDraft = false; model.mode = .editor } label: {
                        Label(model.annotations.isEmpty ? "Edit screenshot" : "Edit marks (\(model.annotations.count))",
                              systemImage: "pencil.tip.crop.circle")
                    }
                    .buttonStyle(QuietPillStyle())
                    .background(Capsule().fill(Theme.raised.opacity(0.9)))
                    .padding(8)
                    .disabled(model.isLocked)
                    .help("Optional: add boxes, arrows, highlights or labels")
                }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }
}

/// "Captured" mark, source app and the project pill.
private struct ComposerHeader: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    var trailing: AnyView? = nil

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(model.isPreview ? Color.orange : Color.accentColor).frame(width: 7, height: 7)
                Text(model.isPreview ? "Preview" : "Captured").font(.callout.weight(.semibold))
            }
            Text(model.source.windowTitle.isEmpty ? model.source.appName : "\(model.source.appName) — \(model.source.windowTitle)")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 12)
            projectPill
            if let trailing { trailing }
        }
    }

    @ViewBuilder
    private var projectPill: some View {
        if app.projects.count > 1 {
            Menu {
                ForEach(app.projects) { p in
                    Button { model.projectId = p.id } label: {
                        if p.id == model.projectId { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                    }
                }
            } label: {
                Pill(text: app.projects.first { $0.id == model.projectId }?.name ?? "Project", systemImage: "folder")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(model.isLocked)
            .help("The project this Work Commit goes to. Switching re-drafts it for that project.")
        } else {
            Pill(text: app.projects.first { $0.id == model.projectId }?.name ?? (model.isPreview ? "Preview project" : "Project"),
                 systemImage: "folder")
                .help("The project this Work Commit goes to")
        }
    }
}

/// The AI's written commit, read like an assistant reply.
private struct AssistantDraft: View {
    @ObservedObject var model: ComposerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AIStatusLine(model: model)
            if hasDraft {
                Text(model.summary.isEmpty ? model.effectiveSummary : model.summary)
                    .font(.system(size: 15, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                ForEach(FieldKind.allCases) { kind in
                    let items = model.fields[keyPath: kind.keyPath].filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
                    if !items.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(kind.heading).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(items) { item in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Circle().fill(Color.secondary.opacity(0.5)).frame(width: 4, height: 4).offset(y: -2)
                                    Text(item.text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                    if let r = item.resolves, !r.isEmpty {
                                        Pill(text: "resolves \(r.count)", systemImage: "checkmark.seal", tint: .green)
                                    }
                                }
                            }
                        }
                    }
                }
            } else if model.drafting {
                placeholderLines
            } else if model.manualReview {
                Text("Nothing drafted yet. Use Edit draft to write it, or Commit with your context as the summary.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.warnings, id: \.self) { w in
                Label(w, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if hasDraft || model.manualReview {
                Button { model.editorFocusesDraft = true; model.mode = .editor } label: {
                    Label("Edit draft", systemImage: "square.and.pencil")
                }
                .buttonStyle(QuietPillStyle())
                .disabled(model.isLocked)
                .help("Change the summary or items. Your edits are kept if you update the draft.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .panel()
    }

    private var hasDraft: Bool {
        !model.summary.trimmingCharacters(in: .whitespaces).isEmpty || model.fieldCount > 0
    }

    private var placeholderLines: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach([0.85, 0.6, 0.7], id: \.self) { w in
                GeometryReader { g in
                    RoundedRectangle(cornerRadius: 4).fill(Theme.subtle).frame(width: g.size.width * w, height: 10)
                }
                .frame(height: 10)
            }
        }
        .accessibilityLabel("AI is writing the draft")
    }
}

/// Honest AI state: writing / written by provider / needs update / failed / not connected / manual / sample.
private struct AIStatusLine: View {
    @ObservedObject var model: ComposerModel

    var body: some View {
        HStack(spacing: 8) {
            content
            Spacer(minLength: 0)
        }
        .font(.callout)
    }

    @ViewBuilder
    private var content: some View {
        if model.isSample {
            Pill(text: "SAMPLE · not written by AI", systemImage: "eye", tint: .orange)
            Text("Preview fixture — AI and Commit are off.").foregroundStyle(.secondary)
        } else if model.drafting {
            ProgressView().controlSize(.small)
            Text(model.appliedInput == nil ? "AI is writing your commit…" : "Updating the draft…").foregroundStyle(.secondary)
        } else if let failure = model.aiFailure {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
            Text(failure).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } else if model.manualReview {
            Image(systemName: "hand.raised").foregroundStyle(.secondary)
            Text("Manual review — you're writing this commit.").foregroundStyle(.secondary)
        } else if let o = model.organizer {
            switch o.mode {
            case .notConfigured:
                Image(systemName: "hand.raised").foregroundStyle(.secondary)
                Text("No AI connected on this server. Continue manually to write it yourself.").foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .unavailable:
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text("AI couldn't finish this draft. Your capture is kept.").foregroundStyle(.secondary)
            case .ai:
                Image(systemName: "sparkles").foregroundStyle(.purple)
                if model.needsUpdate {
                    Text("Context changed — update the draft before committing.").foregroundStyle(.secondary)
                } else {
                    Text("Written by \(o.provider ?? "AI") · review it, then commit").foregroundStyle(.secondary)
                }
            }
        } else if model.appliedInput == nil && !model.isPreview {
            Image(systemName: "sparkles").foregroundStyle(.secondary)
            Text(model.needsUpdate || !model.comment.isEmpty ? "Ready to draft with your context." : "No draft yet.")
                .foregroundStyle(.secondary)
        }
    }
}

/// Optional context for the AI. Return adds a new line.
private struct ContextInput: View {
    @ObservedObject var model: ComposerModel
    var compact: Bool
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $model.comment)
                .font(.body)
                .focused($focused)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 4)
                .padding(.vertical, 6)
            if model.comment.isEmpty {
                Text("Add context for the AI (optional) — what changed, why it matters")
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .allowsHitTesting(false)
            }
        }
        .frame(minHeight: compact ? 40 : 80, maxHeight: compact ? 84 : 140)
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(focused ? Color.accentColor.opacity(0.5) : Theme.hairline))
        .disabled(model.isLocked)
        .accessibilityLabel("Context for the AI")
    }
}

// MARK: - Footer

private struct ComposerFooter: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let requestClose: () -> Void
    let finish: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let p = model.persistError {
                Label(p, systemImage: "externaldrive.badge.exclamationmark").font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let e = model.error {
                Label(e, systemImage: "xmark.octagon").font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.isLocked && model.result == nil && !model.committing {
                Text("Retry resends exactly what was submitted — no new AI draft. To change it, start a new commit.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let r = model.result {
                CommittedBanner(commit: r)
            }
            HStack(spacing: 8) {
                Button(model.isPreview ? "Cancel" : "Save for later", action: requestClose)
                    .buttonStyle(QuietPillStyle())
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.committing)
                    .help(model.isPreview ? "Close the preview" : "Keep this capture in the Commit inbox and close")
                if !model.isPreview && model.result == nil && !model.committing {
                    Button("Discard…") { ComposerController.shared.requestDiscard(model) }
                        .buttonStyle(QuietPillStyle())
                        .help("Delete this capture from this Mac (asks first)")
                }
                if model.result == nil && !model.isLocked {
                    Text("AI drafts · you review · Commit publishes")
                        .font(.caption).foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                secondary
                primary
            }
        }
    }

    @ViewBuilder
    private var secondary: some View {
        if model.isLocked && model.result == nil && !model.committing {
            Button("Edit as new commit") { model.editAsNew() }.buttonStyle(QuietPillStyle())
        }
        if model.offersManual {
            Button("Continue manually") { model.continueManually() }
                .buttonStyle(QuietPillStyle())
                .help("Write and review this commit yourself, without AI")
        }
        if model.manualReview && !model.isLocked && model.result == nil && !model.drafting
            && model.organizer?.mode != .notConfigured {
            Button { Task { await model.draft(app.client) } } label: { Label("Retry AI", systemImage: "sparkles") }
                .buttonStyle(QuietPillStyle())
        }
    }

    private var primary: some View {
        let action = model.primaryAction
        return Button { perform(action) } label: {
            HStack(spacing: 6) {
                switch action {
                case .commit: Text("Commit"); Image(systemName: "arrow.up")
                case .retryCommit: Text("Retry commit"); Image(systemName: "arrow.clockwise")
                case .updateDraft: Text("Update draft"); Image(systemName: "arrow.clockwise")
                case .draftNow: Text("Draft with AI"); Image(systemName: "sparkles")
                case .retryAI: Text("Retry AI"); Image(systemName: "arrow.clockwise")
                case .continueManually: Text("Continue manually"); Image(systemName: "arrow.right")
                case .writing: ProgressView().controlSize(.small); Text("Writing…")
                case .committing: ProgressView().controlSize(.small); Text("Committing…")
                case .done: Text("Done")
                }
            }
        }
        .buttonStyle(PrimaryPillStyle())
        .keyboardShortcut(action == .done ? .defaultAction : KeyboardShortcut(.return, modifiers: .command))
        .disabled(disabled(action))
        .help(help(action))
    }

    private func disabled(_ action: PrimaryAction) -> Bool {
        switch action {
        case .writing, .committing: return true
        case .done: return false
        default: return model.isPreview
        }
    }

    private func help(_ action: PrimaryAction) -> String {
        if model.isPreview { return "Off in preview" }
        switch action {
        case .commit: return "Publish this reviewed Work Commit to the project (⌘↩)"
        case .retryCommit: return "Resend exactly the same commit (⌘↩)"
        case .updateDraft: return "Re-draft with your new context. Nothing is committed (⌘↩)"
        case .draftNow, .retryAI: return "Ask the AI to write the draft. Nothing is committed (⌘↩)"
        case .continueManually: return "Write and review this commit yourself (⌘↩)"
        case .writing: return "The AI is writing the draft"
        case .committing: return "Committing…"
        case .done: return "Close"
        }
    }

    private func perform(_ action: PrimaryAction) {
        switch action {
        case .commit, .retryCommit:
            Task {
                guard await model.commit(app.client) else { return }
                await app.refresh()
                try? await Task.sleep(for: .seconds(1.6))
                finish()
            }
        case .updateDraft, .draftNow, .retryAI:
            Task { await model.draft(app.client) }
        case .continueManually:
            model.continueManually()
        case .done:
            finish()
        case .writing, .committing:
            break
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
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel(radius: 10)
        .onAppear {
            if reduceMotion { shown = true } else { withAnimation(.spring(duration: 0.35, bounce: 0.4)) { shown = true } }
        }
    }
}

// MARK: - Editor (on demand)

private struct CaptureEditor: View {
    @ObservedObject var model: ComposerModel
    @EnvironmentObject var app: AppState
    let requestClose: () -> Void
    let finish: () -> Void

    @State private var tool: AnnotationType = .rect
    @State private var color = annotationColors[0]
    @State private var labelText = ""
    @FocusState private var summaryFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ComposerHeader(model: model, trailing: AnyView(
                Button { model.mode = .card } label: { Label("Done editing", systemImage: "chevron.down") }
                    .buttonStyle(QuietPillStyle())
                    .help("Back to the review card. Marks, context and draft edits are kept.")
            ))
            .padding(.horizontal, 20)
            .padding(.bottom, 10)
            HStack(spacing: 0) {
                canvasPane.disabled(model.isLocked)
                Rectangle().fill(Theme.hairline).frame(width: 1)
                ScrollView { draftEditor.padding(18) }
                    .frame(width: 350)
            }
            ComposerFooter(model: model, requestClose: requestClose, finish: finish)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
        }
        .frame(minWidth: 920, minHeight: 600)
        .onAppear {
            if model.editorFocusesDraft { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { summaryFocused = true } }
        }
    }

    // MARK: Canvas

    private var canvasPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 4) {
                ForEach(toolOrder) { t in
                    Button { tool = t } label: {
                        Label(t.label, systemImage: t.symbol)
                            .font(.callout)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(tool == t ? Theme.selected : .clear))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(tool == t ? Color.primary : Color.secondary)
                    .accessibilityAddTraits(tool == t ? .isSelected : [])
                    .help("\(t.label) tool")
                }
                Rectangle().fill(Theme.hairline).frame(width: 1, height: 18).padding(.horizontal, 6)
                HStack(spacing: 7) {
                    ForEach(Array(annotationColors.enumerated()), id: \.element) { i, c in
                        Button { color = c } label: {
                            Circle().fill(Color(hex: c)).frame(width: 12, height: 12)
                                .overlay(Circle().stroke(Color.primary.opacity(0.6), lineWidth: c == color ? 1.5 : 0).padding(-3))
                                .padding(3)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(colorNames[i]) mark color")
                        .accessibilityAddTraits(c == color ? .isSelected : [])
                        .help("\(colorNames[i]) marks")
                    }
                }
                Spacer(minLength: 8)
                Button { _ = model.annotations.popLast() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                    .buttonStyle(QuietPillStyle())
                    .help("Undo the last mark").disabled(model.annotations.isEmpty)
                Button { model.annotations.removeAll() } label: { Label("Clear", systemImage: "trash") }
                    .buttonStyle(QuietPillStyle())
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
            AnnotationCanvas(image: model.image, annotations: $model.annotations, tool: tool, color: color, text: labelText)
                .modifier(CaptureHighlight(animateArrival: !model.arrivalPulsed) { model.arrivalPulsed = true })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(6)
            Text("Marks are saved with the commit. The AI drafts from the screenshot and your context, not from marks.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
    }

    // MARK: Draft

    private var draftEditor: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Context for the AI").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ContextInput(model: model, compact: false)
            }
            AIStatusLine(model: model)
            Group {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Summary").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    TextField(model.effectiveSummary, text: $model.summary, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14, weight: .medium))
                        .lineLimit(1...4)
                        .focused($summaryFocused)
                        .padding(8)
                        .panel(radius: 8)
                }
                ForEach(FieldKind.allCases) { kind in
                    if !model.fields[keyPath: kind.keyPath].isEmpty { fieldSection(kind) }
                }
                addItemMenu
            }
            .disabled(model.isLocked)
        }
    }

    private var addItemMenu: some View {
        Menu {
            ForEach(FieldKind.allCases) { kind in
                Button(kind.heading) { model.fields[keyPath: kind.keyPath].append(.new()) }
            }
        } label: {
            Label("Add item", systemImage: "plus")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Add a Shipped / Decision / Why / Blocker / Next item")
    }

    private func fieldSection(_ kind: FieldKind) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(kind.heading).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach($model.fields[dynamicMember: kind.keyPath]) { $item in
                HStack(spacing: 6) {
                    TextField(kind.placeholder, text: $item.text, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...3)
                        .padding(7)
                        .panel(radius: 7)
                    if kind == .shipped { resolvesMenu($item) }
                    Button {
                        let id = item.id
                        model.fields[keyPath: kind.keyPath].removeAll { $0.id == id }
                    } label: { Image(systemName: "xmark").imageScale(.small) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
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
            Image(systemName: selected.isEmpty ? "checkmark.seal" : "checkmark.seal.fill")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(selected.isEmpty ? "Resolves…" : "Resolves \(selected.count)")
        .help("Explicitly mark an open blocker / next item as resolved by this")
    }
}
