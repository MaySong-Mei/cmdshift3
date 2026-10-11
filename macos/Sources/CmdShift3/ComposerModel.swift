import AppKit
import Combine
import SwiftUI

/// An open blocker / next item a shipped item can explicitly resolve.
struct OpenItem: Identifiable, Hashable {
    let item: StateItem
    let kind: String
    var id: String { item.id }
}

/// What the AI was asked to organize. A draft result only applies while the
/// composer's input revision is unchanged: equal values reached by A→B→A are
/// still a different input.
struct DraftInput: Equatable {
    let projectId: String
    let comment: String
    /// `ComposerModel.inputRevision` when the request was made.
    let revision: Int
}

/// Light review card by default; the full canvas + draft editor on demand.
enum ComposerMode: Equatable { case card, editor }

/// The single primary action the footer offers for the current state.
enum PrimaryAction: Equatable {
    case commit, retryCommit, updateDraft, draftNow, retryAI, continueManually, writing, committing, done
}

/// Capture → AI writes the Work Commit → a person reviews → explicit Commit.
/// Nothing reaches Git until `commit` runs after review.
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
    /// `--preview-capture`: layout review only — no network, no AI, no Commit.
    let isPreview: Bool
    /// Stable inbox id of this capture (survives edits, restarts and Edit-as-new).
    let draftId: String
    let createdAt: Date
    /// Called right after the payload freezes so the frozen id/content hit disk
    /// before the request is sent (a retry after a crash can't change it).
    var onFrozen: (() -> Void)?

    @Published var projectId: String {
        didSet { if projectId != oldValue { inputRevision += 1 } }
    }
    @Published var annotations: [Annotation] = []
    /// Optional context for the AI ("comment" in API v1).
    @Published var comment = "" {
        didSet { if comment != oldValue { inputRevision += 1 } }
    }
    /// Monotonic: bumped synchronously on every actual project/comment change.
    /// Separate from the request `generation`.
    @Published private(set) var inputRevision = 0
    @Published var summary = ""
    @Published var fields = Fields()
    @Published var openItems: [OpenItem] = []
    @Published var committing = false
    /// Commit error (the AI failure is tracked separately in `aiFailure`).
    @Published var error: String?
    @Published var result: WorkCommit?
    @Published var mode: ComposerMode = .card
    /// Set when the editor was opened from "Edit draft" (focus the text, not the canvas).
    @Published var editorFocusesDraft = false

    @Published private(set) var organizer: Provider?
    @Published private(set) var warnings: [String] = []
    @Published private(set) var drafting = false
    @Published private(set) var aiFailure: String?
    /// The input of the draft currently shown. Differs from `currentInput` → needs update.
    @Published private(set) var appliedInput: DraftInput?
    /// The person explicitly chose to write/review without AI.
    @Published private(set) var manualReview = false
    /// Preview only: the shown draft is a static sample, not AI output.
    @Published private(set) var isSample = false

    /// Monotonic: only the latest draft request may apply its result.
    private var generation = 0
    /// Counts requests actually sent (lets checks prove a frozen retry never re-drafts).
    private(set) var draftRequestsSent = 0
    private var arrived = false
    /// The capture's arrival highlight pulses once per composer, not per mode switch.
    var arrivalPulsed = false
    /// What the last draft inserted (item id → text, and summary), so a
    /// re-draft can replace it without touching the person's own edits.
    private var drafted: [String: String] = [:]
    private var draftedSummary: String?

    init(image: NSImage, png: Data, source: Source, projectId: String, isPreview: Bool = false,
         draftId: String = "dr_" + UUID().uuidString.lowercased(), createdAt: Date = Date()) {
        self.image = image
        self.png = png
        self.source = source
        self.projectId = projectId
        self.isPreview = isPreview
        self.draftId = draftId
        self.createdAt = createdAt
    }

    // MARK: Derived state

    var currentInput: DraftInput {
        DraftInput(projectId: projectId, comment: comment.trimmingCharacters(in: .whitespacesAndNewlines),
                   revision: inputRevision)
    }

    var hasAIDraft: Bool { appliedInput != nil && organizer?.mode == .ai }

    /// Context or project changed since the shown draft was written (by revision).
    var needsUpdate: Bool {
        guard let appliedInput else { return false }
        return appliedInput.revision != inputRevision
    }

    /// Commit is allowed only on a current AI draft, or after an explicit manual choice.
    var reviewReady: Bool {
        guard !isPreview, !drafting else { return false }
        if manualReview { return true }
        return hasAIDraft && !needsUpdate
    }

    var primaryAction: PrimaryAction {
        if result != nil { return .done }
        if committing { return .committing }
        if isLocked { return .retryCommit }
        if drafting { return .writing }
        if reviewReady { return .commit }
        if aiFailure != nil || organizer?.mode == .unavailable { return .retryAI }
        if organizer?.mode == .notConfigured { return .continueManually }
        if appliedInput != nil { return .updateDraft }
        return .draftNow
    }

    /// AI could not write this one: offer the explicit manual path.
    var offersManual: Bool {
        !isPreview && !manualReview && !isLocked && result == nil
            && (aiFailure != nil || organizer?.mode == .unavailable)
    }

    /// Everything open and uncommitted is material: the capture itself, the AI
    /// draft, marks and context. (Preview fixtures only count the person's edits.)
    var isDirty: Bool {
        guard result == nil else { return false }
        guard isPreview else { return true }
        return !annotations.isEmpty || !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var fieldCount: Int { FieldKind.allCases.reduce(0) { $0 + fields[keyPath: $1.keyPath].count } }

    var effectiveSummary: String {
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty { return s }
        if let first = fields.cleaned().shipped.first?.text { return first }
        let line = comment.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.isEmpty ? "Work update from \(source.appName)" : String(line.prefix(140))
    }

    // MARK: AI draft

    /// Runs once when the capture arrives: the AI writes the first draft from
    /// the screenshot alone (empty context is fine). Never commits.
    func arrive(_ client: APIClient) async {
        guard !arrived, !isPreview else { return }
        arrived = true
        Task { await loadOpenItems(client) }
        await draft(client)
    }

    func loadOpenItems(_ client: APIClient) async {
        guard !isPreview else { return }
        let pid = projectId
        guard let s = try? await client.state(project: pid).state else { if pid == projectId { openItems = [] }; return }
        guard pid == projectId else { return }
        openItems = s.blockers.map { OpenItem(item: $0, kind: "BLOCKER") } + s.next.map { OpenItem(item: $0, kind: "NEXT") }
    }

    /// Re-organizes for the current input. Only drafts — never posts a commit.
    func draft(_ client: APIClient) async {
        guard let (gen, input) = beginDraft() else { return }
        let token = client.token
        draftRequestsSent += 1
        do {
            let r = try await client.draft(DraftRequest(projectId: input.projectId, comment: input.comment, source: source,
                                                        imageBase64: png.base64EncodedString()))
            // A different identity signed in meanwhile: the result is not theirs.
            guard client.token == token else { abandon(gen); return }
            applyDraft(r, gen: gen, input: input)
        } catch {
            failDraft(error, gen: gen, input: input)
        }
    }

    /// Starts a request generation for the current input; nil when no AI request may be sent.
    func beginDraft() -> (gen: Int, input: DraftInput)? {
        guard !isPreview, !isLocked, result == nil else { return nil }
        generation += 1
        drafting = true
        aiFailure = nil
        return (generation, currentInput)
    }

    private func abandon(_ gen: Int) {
        if gen == generation { drafting = false }
    }

    /// Applies a draft only if it is the latest request, the input revision is
    /// unchanged since it was sent and nothing is frozen. Returns whether it applied.
    @discardableResult
    func applyDraft(_ r: DraftResponse, gen: Int, input: DraftInput) -> Bool {
        guard gen == generation else { return false }
        drafting = false
        guard input.revision == inputRevision, input == currentInput, !isLocked else { return false }
        // Replace the previous draft's untouched items; keep anything the person
        // typed or edited (and any resolves they linked).
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
            let current = summary.trimmingCharacters(in: .whitespacesAndNewlines)
            if current.isEmpty || current == draftedSummary { summary = s }
            draftedSummary = s
        }
        organizer = r.organizer
        warnings = r.warnings ?? []
        appliedInput = input
        aiFailure = nil
        // A fresh AI draft puts the AI-first review back in charge.
        if organizer?.mode == .ai { manualReview = false }
        return true
    }

    /// Records an AI failure for the latest request while its input revision is
    /// still current. The capture, context, marks and any earlier draft all stay.
    @discardableResult
    func failDraft(_ error: Error, gen: Int, input: DraftInput) -> Bool {
        guard gen == generation else { return false }
        drafting = false
        guard input.revision == inputRevision, !isLocked else { return false }
        aiFailure = Self.describeAIFailure(error)
        return true
    }

    static func describeAIFailure(_ error: Error) -> String {
        guard let e = error as? APIError else { return "AI draft failed: \(error.localizedDescription)" }
        switch e.status {
        case 429: return "AI limit reached for now. Your capture is kept — retry in a minute, or continue manually."
        case 401: return "Your session expired. Sign in again, then retry AI. Your capture is kept."
        case 0 where e.code == "network": return "Can't reach the server. Your capture is kept — retry AI when you're back online."
        default: return "AI couldn't write this draft (\(e.message)). Your capture is kept."
        }
    }

    /// Explicit opt-in to a human-written review when AI can't help.
    func continueManually() {
        guard !isPreview, !isLocked, result == nil else { return }
        manualReview = true
    }

    /// Resolves references and AI state are project-scoped: drop them and re-organize.
    func projectChanged(_ client: APIClient) async {
        resetForProjectSwitch()
        guard !isPreview, !isLocked else { return }
        Task { await loadOpenItems(client) }
        await draft(client)
    }

    func resetForProjectSwitch() {
        for i in fields.shipped.indices { fields.shipped[i].resolves = nil }
        organizer = nil
        warnings = []
        openItems = []
        aiFailure = nil
        appliedInput = nil
        manualReview = false
    }

    // MARK: Commit

    /// Freezes the payload and id on the first write attempt. In-flight drafts
    /// belong to the pre-commit state, so they are invalidated.
    @discardableResult
    func freeze() -> CommitRequest {
        if let frozen { return frozen }
        let req = CommitRequest(id: commitId, projectId: projectId, source: source,
                                imageBase64: png.base64EncodedString(), annotations: annotations,
                                comment: comment, summary: effectiveSummary, fields: fields.cleaned())
        generation += 1
        drafting = false
        frozen = req
        onFrozen?()
        return req
    }

    /// Writes the reviewed Work Commit. Refused unless the draft is reviewed
    /// (current AI draft or explicit manual review) or this is a frozen retry.
    /// Every draft with a commit request in flight, open or not. Session and
    /// capture switches consult this, not just the currently shown composer.
    static var committingDrafts: Set<String> = []

    @discardableResult
    func commit(_ client: APIClient) async -> Bool {
        guard !isPreview, !committing, result == nil else { return false }
        guard isLocked || reviewReady else { return false }
        committing = true
        Self.committingDrafts.insert(draftId)
        error = nil
        defer { committing = false; Self.committingDrafts.remove(draftId) }
        let req = freeze()
        do {
            result = try await client.commit(req)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
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

    // MARK: Preview

    /// Preview only: a clearly labeled static sample so the card ↔ editor
    /// layout can be reviewed without any AI or network.
    func loadSample() {
        guard isPreview else { return }
        isSample = true
        summary = "Sample draft — capture card layout check"
        fields.shipped = [.new("Sample: the capture opens as a light review card")]
        fields.next = [.new("Sample: review the draft, then Commit")]
    }
}

// MARK: - Durable inbox (T27)

extension ComposerModel {
    /// Everything needed to resume this capture later. No credentials.
    func snapshot(endpoint: String, userId: String) -> StoredDraft {
        StoredDraft(id: draftId, createdAt: createdAt, updatedAt: Date(), endpoint: endpoint, userId: userId,
                    projectId: projectId, source: source, commitId: commitId, annotations: annotations,
                    comment: comment, summary: summary, fields: fields, organizer: organizer, warnings: warnings,
                    aiFailure: aiFailure, manualReview: manualReview,
                    appliedProjectId: appliedInput?.projectId, appliedComment: appliedInput?.comment,
                    drafted: drafted, draftedSummary: draftedSummary,
                    frozen: frozen.map(FrozenCommit.init), lastError: error)
    }

    /// Rebuilds a composer from disk without sending an AI request. A draft written
    /// for the same input is review-ready again; a changed input needs an update;
    /// a frozen draft can only be retried with the same id and content.
    static func restore(_ d: StoredDraft, png: Data, image: NSImage) -> ComposerModel {
        let m = ComposerModel(image: image, png: png, source: d.source, projectId: d.projectId,
                              draftId: d.id, createdAt: d.createdAt)
        m.arrived = true                 // never auto-draft on resume
        m.commitId = d.commitId
        m.annotations = d.annotations
        m.comment = d.comment
        m.summary = d.summary
        m.fields = d.fields
        m.organizer = d.organizer
        m.warnings = d.warnings
        m.aiFailure = d.aiFailure
        m.manualReview = d.manualReview
        m.drafted = d.drafted
        m.draftedSummary = d.draftedSummary
        m.error = d.lastError
        if let p = d.appliedProjectId, let c = d.appliedComment {
            let same = p == m.projectId && c == m.comment.trimmingCharacters(in: .whitespacesAndNewlines)
            // Same input → current revision (ready); otherwise an older revision (needs update).
            m.appliedInput = DraftInput(projectId: p, comment: c, revision: same ? m.inputRevision : m.inputRevision - 1)
        }
        if let f = d.frozen { m.frozen = f.request(png: png) }
        return m
    }
}

@MainActor
final class ComposerController: NSObject, NSWindowDelegate {
    static let shared = ComposerController()
    private var window: NSWindow?
    private var model: ComposerModel?
    private var modeSink: AnyCancellable?
    private var saveSink: AnyCancellable?
    /// Where the open capture is persisted, and for whom (set at open time).
    private var store: DraftStore?
    private var scope: (endpoint: String, userId: String)?
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

    /// A commit request is in flight: closing or switching identity must wait.
    var isCommitting: Bool { model?.committing == true || !ComposerModel.committingDrafts.isEmpty }

    /// Sign-out / account switch: saves the open capture to its owner's inbox and
    /// closes it, so it can't be committed under the next user. Callers must check
    /// `isCommitting` first.
    func closeAll() {
        // Defensive only: session actions must check `isCommitting` themselves.
        guard let window, !isCommitting else { return }
        saveNow()
        forceClose(window)
    }

    /// The draft currently open (if any) — lets the inbox avoid opening it twice.
    var openDraftId: String? { model?.draftId }

    // MARK: Durable inbox

    /// Persists the open capture now. A committed capture is removed instead.
    func saveNow() {
        guard let model, let store, let scope, !model.isPreview else { return }
        let snap = model.snapshot(endpoint: scope.endpoint, userId: scope.userId)
        if model.result != nil {
            store.remove(snap)
        } else {
            try? store.save(snap, png: model.png)
        }
        NotificationCenter.default.post(name: .cmd3InboxChanged, object: nil)
    }

    /// Saves and closes the open capture so a new one can start. Refused while committing.
    @discardableResult
    func stashCurrent() -> Bool {
        guard let window else { return true }
        guard !isCommitting else { bringToFront(); return false }
        saveNow()
        forceClose(window)
        return true
    }

    /// Explicit, confirmed discard of the open capture (removes it from the inbox).
    func requestDiscard(_ target: ComposerModel) {
        guard let window, model === target, !target.committing else { return }
        let alert = NSAlert()
        alert.messageText = "Discard this capture?"
        alert.informativeText = "The screenshot, its draft and your edits will be deleted from this Mac. Nothing was committed."
        alert.addButton(withTitle: "Keep")
        alert.addButton(withTitle: "Discard")
        alert.buttons[1].hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn, let self, self.window === window, self.model === target else { return }
            if let store = self.store, let scope = self.scope {
                store.remove(target.snapshot(endpoint: scope.endpoint, userId: scope.userId))
            }
            self.model = nil                         // don't re-save on close
            self.forceClose(window)
            NotificationCenter.default.post(name: .cmd3InboxChanged, object: nil)
        }
    }

    /// Reopens a saved capture exactly as it was — no new AI request.
    func resume(_ d: StoredDraft, app: AppState) {
        if openDraftId == d.id { bringToFront(); return }
        guard stashCurrent(), let store = app.draftStore, let png = store.png(for: d), let image = NSImage(data: png) else { return }
        show(ComposerModel.restore(d, png: png, image: image), app: app, preview: false, arrive: false)
    }

    /// Closes exactly `target` without the discard prompt. A stale caller (an
    /// older composer's delayed finish) can never close a newer window: only
    /// `target` itself is closed, and the guard flag is scoped to it.
    func forceClose(_ target: NSWindow) {
        if target === window { allowClose = true }
        target.close()
    }

    static func contentSize(for mode: ComposerMode) -> NSSize {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        switch mode {
        case .card: return NSSize(width: min(700, visible.width - 40), height: min(740, visible.height - 40))
        case .editor: return NSSize(width: min(1200, visible.width - 40), height: min(800, visible.height - 40))
        }
    }

    func open(image: NSImage, png: Data, source: Source, app: AppState, preview: Bool = false) {
        guard stashCurrent() else { return }
        guard let pid = preview ? (app.projectId ?? "preview") : app.projectId else { return }
        let model = ComposerModel(image: image, png: png, source: source, projectId: pid, isPreview: preview)
        if preview { model.loadSample() }
        show(model, app: app, preview: preview, arrive: !preview)
    }

    private func show(_ model: ComposerModel, app: AppState, preview: Bool, arrive: Bool) {
        let source = model.source
        // Each composer's buttons act on its own window only, never `self.window`
        // at call time (which may already be a newer capture).
        weak var own: NSWindow?
        let view = ComposerView(model: model,
                                requestClose: { own?.performClose(nil) },
                                finish: { [weak self] in if let own { self?.forceClose(own) } })
            .environmentObject(app)
        let size = Self.contentSize(for: .card)
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = preview ? "Work Commit — Preview" : "Work Commit — \(source.appName)"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.backgroundColor = .cmd3Surface
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
        own = w
        adopt(w, model: model)
        // Persist the capture before anything else can happen to it, then on every edit.
        if !preview, let user = app.user {
            store = app.draftStore
            scope = (app.endpoint, user.id)
            model.onFrozen = { [weak self] in self?.saveNow() }
            saveNow()
            saveSink = model.objectWillChange
                .debounce(for: .milliseconds(400), scheduler: RunLoop.main)
                .sink { [weak self] in self?.saveNow() }
        } else {
            store = nil
            scope = nil
            saveSink = nil
        }
        // Card ↔ editor is the same window and model: just resize around its center.
        modeSink = model.$mode.dropFirst().removeDuplicates().sink { [weak w] mode in
            DispatchQueue.main.async {
                guard let w, w.isVisible else { return }
                Self.resize(w, to: Self.contentSize(for: mode))
            }
        }
        // The AI writes the first draft as soon as a new capture arrives (not on resume).
        if arrive { Task { await model.arrive(app.client) } }
    }

    private static func resize(_ w: NSWindow, to content: NSSize) {
        var frame = w.frameRect(forContentRect: NSRect(origin: .zero, size: content))
        frame.origin = NSPoint(x: w.frame.midX - frame.width / 2, y: w.frame.maxY - frame.height)
        if let visible = w.screen?.visibleFrame {
            frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        }
        w.setFrame(frame, display: true, animate: !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    }

    /// Offline checks only: attach a store/scope to an adopted window without the UI.
    func attachStoreForChecks(_ store: DraftStore, endpoint: String, userId: String) {
        self.store = store
        scope = (endpoint, userId)
    }

    /// Makes `w` the current composer window (also used by the offline guard checks).
    func adopt(_ w: NSWindow, model: ComposerModel) {
        w.delegate = self
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
        // Real captures are durable: closing saves them back to the Commit inbox.
        if !model.isPreview {
            saveNow()
            return true
        }
        guard model.isDirty else { return true }
        let alert = NSAlert()
        alert.messageText = "Discard this capture?"
        alert.informativeText = "The screenshot, its AI draft and your edits haven't been committed yet."
        alert.addButton(withTitle: "Keep Editing")
        alert.addButton(withTitle: "Discard")
        alert.buttons[1].hasDestructiveAction = true
        // Discard applies only if this same window/model is still current.
        let target = sender
        let targetModel = model
        alert.beginSheetModal(for: sender) { [weak self] response in
            guard response == .alertSecondButtonReturn, let self,
                  self.window === target, self.model === targetModel else { return }
            self.forceClose(target)
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === window {
            saveNow()                 // last edits (or removal after a successful Commit)
            window = nil
            model = nil
            modeSink = nil
            saveSink = nil
        }
    }
}
