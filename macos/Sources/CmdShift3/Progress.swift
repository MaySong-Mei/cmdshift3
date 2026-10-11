import SwiftUI

// MARK: Model — same semantics as web/app.js `progressTreeData` / `progressMemberColors`
//
// Tasks come only from recorded `blocker` / `next` items. A later `shipped` item
// completes a task only through an explicit `resolves` of that task's item id;
// a shipped item without a valid resolve is its own completed task. Decisions /
// reasons (and records with no task items) are supporting records. Nothing is
// inferred: no ownership, percentages or AI completion.

struct ProgressEvidence: Identifiable, Hashable {
    let commitId: String
    let itemId: String?
    let text: String
    let summary: String
    let role: String
    let author: User?
    let gitSha: String
    let remoteSynced: Bool
    let createdAt: String?
    let sourceApp: String
    let mine: Bool
    var facts: [Fact] = []

    struct Fact: Hashable { let kind: String; let text: String }
    var id: String { commitId + "/" + (itemId ?? role) }
    var shortSha: String { String(gitSha.prefix(7)) }
}

struct ProgressTask: Identifiable, Hashable {
    enum Status: String { case blocked, open, completed }
    let id: String
    let text: String
    let kind: String
    var status: Status
    let recordedBy: User?
    let sequence: Int
    var evidence: [ProgressEvidence]
}

struct ProgressTree {
    var tasks: [ProgressTask]
    var supporting: [ProgressEvidence]
    var members: [User]
    var commitCount: Int
    var mineCount: Int

    static func build(commits: [WorkCommit], projectId: String, currentUserId: String?, members: [User]) -> ProgressTree {
        let records = commits.filter { $0.projectId == projectId }.sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) }
        var tasks: [ProgressTask] = []
        var taskIndex: [String: Int] = [:]
        var supporting: [ProgressEvidence] = []
        var contributors: [String: User] = [:]
        var order: [String] = []
        func addContributor(_ u: User) {
            if contributors[u.id] == nil { order.append(u.id) }
            contributors[u.id] = User(id: u.id, name: u.name.isEmpty ? "Project member" : u.name)
        }
        for m in members where !m.id.isEmpty { addContributor(m) }

        func evidence(_ c: WorkCommit, _ item: FieldItem?, _ role: String) -> ProgressEvidence {
            let summary = c.summary ?? c.comment ?? "Work commit"
            return ProgressEvidence(commitId: c.id, itemId: item?.id, text: item?.text ?? summary, summary: summary, role: role,
                                    author: c.author, gitSha: c.git?.sha ?? "", remoteSynced: c.git?.remoteSynced ?? false,
                                    createdAt: c.createdAt, sourceApp: c.source?.appName.isEmpty == false ? c.source!.appName : "Capture",
                                    mine: c.author?.id != nil && c.author?.id == currentUserId)
        }

        for c in records {
            if let a = c.author { addContributor(a) }
            let f = c.fields ?? Fields()
            let seq = c.sequence ?? 0
            for (kind, items) in [("blocker", f.blocker), ("next", f.next)] {
                for item in items {
                    taskIndex[item.id] = tasks.count
                    tasks.append(ProgressTask(id: item.id, text: item.text, kind: kind, status: kind == "blocker" ? .blocked : .open,
                                              recordedBy: c.author, sequence: seq, evidence: [evidence(c, item, "Task recorded")]))
                }
            }
            for item in f.shipped {
                var seen = Set<String>()
                let targets = (item.resolves ?? []).filter { seen.insert($0).inserted }
                    .compactMap { taskIndex[$0] }.filter { tasks[$0].sequence < seq }
                if !targets.isEmpty {
                    for i in targets {
                        tasks[i].status = .completed
                        tasks[i].evidence.append(evidence(c, item, "Completed work"))
                    }
                } else {
                    tasks.append(ProgressTask(id: item.id, text: item.text, kind: "shipped", status: .completed,
                                              recordedBy: c.author, sequence: seq, evidence: [evidence(c, item, "Shipped work")]))
                }
            }
            let facts = f.decision.map { ProgressEvidence.Fact(kind: "decision", text: $0.text) }
                + f.why.map { ProgressEvidence.Fact(kind: "why", text: $0.text) }
            let hasTaskItems = !(f.blocker.isEmpty && f.next.isEmpty && f.shipped.isEmpty)
            if !facts.isEmpty || !hasTaskItems {
                var e = evidence(c, nil, "Supporting record")
                e.facts = facts
                supporting.append(e)
            }
        }
        let rank: [ProgressTask.Status: Int] = [.blocked: 0, .open: 1, .completed: 2]
        let sorted = tasks.enumerated().sorted { l, r in
            let a = rank[l.element.status]!, b = rank[r.element.status]!
            if a != b { return a < b }
            if l.element.sequence != r.element.sequence { return l.element.sequence > r.element.sequence }
            return l.offset < r.offset   // stable, like Array.prototype.sort
        }.map(\.element)
        let memberList = order.compactMap { contributors[$0] }.sorted { $0.id < $1.id }
        return ProgressTree(tasks: sorted, supporting: supporting.reversed(), members: memberList,
                            commitCount: records.count, mineCount: records.filter { $0.author?.id == currentUserId && currentUserId != nil }.count)
    }
}

/// Stable, distinct member colors — identical palette and FNV-1a hashing to the web,
/// so a teammate has the same color in the browser and on the Mac.
@MainActor
final class MemberColors {
    static let palette = ["#526eab", "#ae6945", "#6e8753", "#9b618d", "#477f84", "#9e7b32", "#856fb0", "#b15e6b"]
    private(set) var registry: [String: String] = [:]

    static func fnv(_ id: String) -> UInt32 {
        var hash: UInt32 = 2166136261
        // JS `for (const char of id)` + charCodeAt(0): first UTF-16 unit of each code point.
        for scalar in id.unicodeScalars {
            let unit = UInt32(String(scalar).utf16.first ?? 0)
            hash = (hash ^ unit) &* 16777619
        }
        return hash
    }

    @discardableResult
    func assign(_ members: [User]) -> [String: String] {
        var used = Set(registry.values)
        for m in members where registry[m.id] == nil {
            let hash = Self.fnv(m.id)
            var color: String?
            for offset in 0..<Self.palette.count {
                let candidate = Self.palette[Int((UInt64(hash) + UInt64(offset)) % UInt64(Self.palette.count))]
                if !used.contains(candidate) { color = candidate; break }
            }
            if color == nil {
                var hue = Double(hash % 3600) / 10
                var c = "hsl(\(Self.fmt(hue)) 42% 42%)"
                while used.contains(c) { hue = (hue + 137.5).truncatingRemainder(dividingBy: 360); c = "hsl(\(Self.fmt(hue)) 42% 42%)" }
                color = c
            }
            registry[m.id] = color
            used.insert(color!)
        }
        return registry
    }

    func color(for id: String?) -> Color {
        guard let id, let s = registry[id] else { return Color(hex: "#777e76") }
        return Self.swiftColor(s)
    }

    private static func fmt(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }

    static func swiftColor(_ s: String) -> Color {
        if s.hasPrefix("#") { return Color(hex: s) }
        // "hsl(H 42% 42%)"
        let nums = s.replacingOccurrences(of: "hsl(", with: "").replacingOccurrences(of: ")", with: "")
            .replacingOccurrences(of: "%", with: "").split(separator: " ").compactMap { Double($0) }
        guard nums.count == 3 else { return Color(hex: "#777e76") }
        let h = nums[0] / 360, sat = nums[1] / 100, l = nums[2] / 100
        let b = l + sat * min(l, 1 - l)
        let sv = b == 0 ? 0 : 2 * (1 - l / b)
        return Color(hue: h, saturation: sv, brightness: b)
    }
}

// MARK: Views

struct ProjectProgressView: View {
    @EnvironmentObject var app: AppState
    @State private var highlightMine = true
    @State private var collapsed: Set<String> = []

    var body: some View {
        let tree = app.progressTree
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(tree)
                if tree.tasks.isEmpty && tree.supporting.isEmpty {
                    Text("No work recorded yet. Press \(HotKey.displayString) to commit your first update.")
                        .foregroundStyle(.secondary)
                }
                ForEach(tree.tasks) { task in taskCard(task) }
                if !tree.supporting.isEmpty {
                    Text("SUPPORTING RECORDS").font(.caption.bold()).foregroundStyle(.secondary).padding(.top, 6)
                    ForEach(tree.supporting) { e in EvidenceRow(evidence: e, highlightMine: highlightMine) }
                }
            }
            .padding(20)
            .frame(maxWidth: 860, alignment: .leading)
        }
    }

    private func header(_ tree: ProgressTree) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SHARED PROJECT").font(.caption.bold()).foregroundStyle(.secondary)
            Text(app.currentProject?.name ?? "Project").font(.title2.bold())
            HStack(spacing: 14) {
                countPill("Blocked", tree.tasks.filter { $0.status == .blocked }.count, .red)
                countPill("Up next", tree.tasks.filter { $0.status == .open }.count, .orange)
                countPill("Completed", tree.tasks.filter { $0.status == .completed }.count, .green)
                Spacer()
                Toggle("Highlight my work", isOn: $highlightMine).toggleStyle(.checkbox)
            }
            MemberLegend(members: tree.members)
            Text("Follow each task to the work behind it. Status comes only from recorded items and explicit resolves.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func countPill(_ label: String, _ n: Int, _ tint: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text("\(n) \(label)").font(.callout.monospacedDigit())
        }
    }

    private func taskCard(_ task: ProgressTask) -> some View {
        let open = Binding(get: { !collapsed.contains(task.id) },
                           set: { if $0 { collapsed.remove(task.id) } else { collapsed.insert(task.id) } })
        return DisclosureGroup(isExpanded: open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(task.evidence) { e in EvidenceRow(evidence: e, highlightMine: highlightMine) }
            }
            .padding(.leading, 6).padding(.top, 4)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                statusBadge(task.status)
                Text(task.text).font(.body.weight(.medium)).textSelection(.enabled)
                Spacer()
                Text("\(task.evidence.count) record\(task.evidence.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.06)))
    }

    private func statusBadge(_ s: ProgressTask.Status) -> some View {
        let (label, tint): (String, Color) = switch s {
        case .blocked: ("Blocked", .red)
        case .open: ("Up next", .orange)
        case .completed: ("Completed", .green)
        }
        return Text(label).font(.caption.weight(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.12)))
    }
}

struct MemberLegend: View {
    @EnvironmentObject var app: AppState
    let members: [User]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(members, id: \.id) { m in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(app.memberColors.color(for: m.id)).frame(width: 14, height: 4)
                    Text(m.name + (m.id == app.user?.id ? " (you)" : "")).font(.caption)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// One contribution: member-colored line, author/role, text, SHA → opens the existing detail.
struct EvidenceRow: View {
    @EnvironmentObject var app: AppState
    let evidence: ProgressEvidence
    let highlightMine: Bool

    var body: some View {
        Button {
            app.selectedCommitId = evidence.commitId
            app.mainTab = .feed
        } label: {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(app.memberColors.color(for: evidence.author?.id))
                    .frame(width: highlightMine && evidence.mine ? 5 : 3)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(evidence.author?.name ?? "Project member").font(.caption.weight(.semibold))
                        Text(evidence.role).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if !evidence.gitSha.isEmpty {
                            Text(evidence.shortSha).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                    Text(evidence.text).font(.callout).multilineTextAlignment(.leading)
                    ForEach(evidence.facts, id: \.self) { f in
                        Text("\(f.kind.uppercased()) · \(f.text)").font(.caption).foregroundStyle(.secondary)
                    }
                    Text("\(evidence.sourceApp) · \(relativeTime(evidence.createdAt.flatMap(parseISODate)))")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(highlightMine && evidence.mine ? app.memberColors.color(for: evidence.author?.id).opacity(0.08) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open this record's evidence, SHA and discussion")
    }
}

/// Browse each contributor's recorded work (same colors as the Progress tree).
struct PeopleView: View {
    @EnvironmentObject var app: AppState
    @State private var selected: String?

    var body: some View {
        let tree = app.progressTree
        HSplitView {
            List(tree.members, id: \.id, selection: $selected) { m in
                let mine = app.commits.filter { $0.author?.id == m.id }
                HStack(spacing: 8) {
                    Circle().fill(app.memberColors.color(for: m.id)).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(m.name + (m.id == app.user?.id ? " (you)" : ""))
                        Text("\(mine.count) record\(mine.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .tag(m.id)
            }
            .frame(minWidth: 200, idealWidth: 230, maxWidth: 300)

            if let id = selected ?? tree.members.first?.id {
                let records = app.commits.filter { $0.author?.id == id }
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if records.isEmpty {
                            Text("No recorded work from this member yet.").foregroundStyle(.secondary)
                        }
                        ForEach(records) { c in
                            Button {
                                app.selectedCommitId = c.id
                                app.mainTab = .feed
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    RoundedRectangle(cornerRadius: 2).fill(app.memberColors.color(for: id)).frame(width: 3)
                                    CommitCard(commit: c)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 820, alignment: .leading)
                }
            } else {
                ContentUnavailableView("No members yet", systemImage: "person.2")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// Grounded project questions arrive with lead's T23 API; until then this is explicit, not a fake chat.
struct AskView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Ask about this project", systemImage: "bubble.left.and.text.bubble.right")
        } description: {
            Text("Answers will cite confirmed work records and their Git SHAs. This view is waiting for the project question service and is not connected yet.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
