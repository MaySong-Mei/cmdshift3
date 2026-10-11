import Foundation

// Mirrors docs/API.md (v1). Decoding is lenient so a missing optional key
// from the server does not break the whole response.

struct User: Codable, Hashable {
    let id: String
    let name: String
}

struct Project: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let description: String?
}

struct SessionResponse: Decodable {
    let token: String
    let user: User
    let projects: [Project]
}

struct MeResponse: Decodable {
    let user: User
    let projects: [Project]
}

struct Source: Codable, Hashable {
    var appName: String
    var windowTitle: String
    var captureKind: String

    init(appName: String, windowTitle: String, captureKind: String) {
        self.appName = appName
        self.windowTitle = windowTitle
        self.captureKind = captureKind
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appName = try c.decodeIfPresent(String.self, forKey: .appName) ?? ""
        windowTitle = try c.decodeIfPresent(String.self, forKey: .windowTitle) ?? ""
        captureKind = try c.decodeIfPresent(String.self, forKey: .captureKind) ?? "region"
    }
}

struct FieldItem: Codable, Hashable, Identifiable {
    var id: String
    var text: String
    var resolves: [String]?

    static func new(_ text: String = "") -> FieldItem {
        FieldItem(id: "it_" + UUID().uuidString.lowercased(), text: text, resolves: nil)
    }
}

enum FieldKind: String, CaseIterable, Identifiable {
    case shipped, decision, why, blocker, next
    var id: String { rawValue }
    var title: String { rawValue.uppercased() }
    var keyPath: WritableKeyPath<Fields, [FieldItem]> {
        switch self {
        case .shipped: return \.shipped
        case .decision: return \.decision
        case .why: return \.why
        case .blocker: return \.blocker
        case .next: return \.next
        }
    }
    var placeholder: String {
        switch self {
        case .shipped: return "What got done"
        case .decision: return "What was decided"
        case .why: return "Why"
        case .blocker: return "What is blocking"
        case .next: return "What happens next"
        }
    }
}

struct Fields: Codable, Hashable {
    var shipped: [FieldItem] = []
    var decision: [FieldItem] = []
    var why: [FieldItem] = []
    var blocker: [FieldItem] = []
    var next: [FieldItem] = []

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shipped = try c.decodeIfPresent([FieldItem].self, forKey: .shipped) ?? []
        decision = try c.decodeIfPresent([FieldItem].self, forKey: .decision) ?? []
        why = try c.decodeIfPresent([FieldItem].self, forKey: .why) ?? []
        blocker = try c.decodeIfPresent([FieldItem].self, forKey: .blocker) ?? []
        next = try c.decodeIfPresent([FieldItem].self, forKey: .next) ?? []
    }

    var isEmpty: Bool {
        shipped.isEmpty && decision.isEmpty && why.isEmpty && blocker.isEmpty && next.isEmpty
    }

    /// Drops blank items and keeps `resolves` only on shipped items (API v1 rule).
    /// Written per-field on purpose: a closure over the computed subscript was
    /// miscompiled in -O builds (Swift 6.4), silently returning empty fields.
    func cleaned() -> Fields {
        var out = Fields()
        out.shipped = Self.clean(shipped, keepResolves: true)
        out.decision = Self.clean(decision, keepResolves: false)
        out.why = Self.clean(why, keepResolves: false)
        out.blocker = Self.clean(blocker, keepResolves: false)
        out.next = Self.clean(next, keepResolves: false)
        return out
    }

    private static func clean(_ items: [FieldItem], keepResolves: Bool) -> [FieldItem] {
        var out: [FieldItem] = []
        for item in items {
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            out.append(FieldItem(id: item.id, text: text, resolves: keepResolves ? (item.resolves ?? []) : nil))
        }
        return out
    }
}

enum AnnotationType: String, Codable, CaseIterable, Identifiable {
    case rect, arrow, text, highlight
    var id: String { rawValue }
    var label: String {
        switch self {
        case .rect: return "Box"
        case .arrow: return "Arrow"
        case .text: return "Text"
        case .highlight: return "Highlight"
        }
    }
    var symbol: String {
        switch self {
        case .rect: return "rectangle"
        case .arrow: return "arrow.up.right"
        case .text: return "textformat"
        case .highlight: return "highlighter"
        }
    }
}

/// Coordinates are relative to the image (0–1). For arrows, (x, y) is the
/// start point and (w, h) is the signed delta to the end point.
struct Annotation: Codable, Hashable, Identifiable {
    var id = UUID()
    var type: AnnotationType
    var x: Double
    var y: Double
    var w: Double
    var h: Double
    var text: String?
    var color: String

    enum CodingKeys: String, CodingKey { case type, x, y, w, h, text, color }
}

struct Evidence: Codable, Hashable {
    let imageUrl: String?
    let annotations: [Annotation]?
}

struct GitInfo: Codable, Hashable {
    let sha: String?
    let parentSha: String?
    let branch: String?
    let remoteSynced: Bool?
}

struct WorkCommit: Codable, Hashable, Identifiable {
    let id: String
    let projectId: String?
    let source: Source?
    let comment: String?
    let summary: String?
    let fields: Fields?
    let author: User?
    let createdAt: String?
    let sequence: Int?
    let evidence: Evidence?
    let git: GitInfo?

    var shortSha: String? { git?.sha.map { String($0.prefix(7)) } }
    var date: Date? { createdAt.flatMap(parseISODate) }
}

struct CommitEnvelope: Decodable { let commit: WorkCommit }

struct CommitsResponse: Decodable {
    let commits: [WorkCommit]
    let throughSequence: Int?
}

struct StateItem: Codable, Hashable, Identifiable {
    let id: String
    let text: String
    let commitId: String?
    let author: User?
    let createdAt: String?
    let gitSha: String?
}

struct ProjectState: Codable, Hashable {
    var shipped: [StateItem] = []
    var decisions: [StateItem] = []
    var blockers: [StateItem] = []
    var next: [StateItem] = []

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shipped = try c.decodeIfPresent([StateItem].self, forKey: .shipped) ?? []
        decisions = try c.decodeIfPresent([StateItem].self, forKey: .decisions) ?? []
        blockers = try c.decodeIfPresent([StateItem].self, forKey: .blockers) ?? []
        next = try c.decodeIfPresent([StateItem].self, forKey: .next) ?? []
    }
}

struct StateResponse: Decodable {
    let state: ProjectState
    let throughSequence: Int?
}

struct Provider: Codable, Hashable {
    let provider: String?
    let status: String?

    /// True when the server says no AI/sponsor is connected (API v1 "manual").
    var isManual: Bool { (provider ?? "manual").lowercased() == "manual" }
}

struct DraftResponse: Decodable {
    let summary: String?
    let fields: Fields?
    let organizer: Provider?
    let warnings: [String]?
}

struct CatchupResponse: Decodable {
    let sinceSequence: Int?
    let throughSequence: Int?
    let commits: [WorkCommit]
    let summary: String?
    let state: ProjectState?
    let analyzer: Provider?

    enum CodingKeys: String, CodingKey {
        case sinceSequence, throughSequence, commits, summary, state, analyzer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sinceSequence = try c.decodeIfPresent(Int.self, forKey: .sinceSequence)
        throughSequence = try c.decodeIfPresent(Int.self, forKey: .throughSequence)
        commits = try c.decodeIfPresent([WorkCommit].self, forKey: .commits) ?? []
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        state = try? c.decodeIfPresent(ProjectState.self, forKey: .state)
        analyzer = try? c.decodeIfPresent(Provider.self, forKey: .analyzer)
    }
}

struct Comment: Codable, Hashable, Identifiable {
    let id: String
    let commitId: String?
    let author: User?
    let body: String
    let createdAt: String?
}

struct CommentsResponse: Decodable { let comments: [Comment] }
struct CommentEnvelope: Decodable { let comment: Comment }
struct SeenResponse: Decodable { let seenSequence: Int? }

struct ErrorEnvelope: Decodable {
    struct Body: Decodable { let code: String; let message: String }
    let error: Body
}

// MARK: Requests

struct SessionRequest: Encodable { let code: String }

struct DraftRequest: Encodable {
    let projectId: String
    let comment: String
    let source: Source
    let imageBase64: String?
}

struct CommitRequest: Encodable {
    let id: String
    let projectId: String
    let source: Source
    let imageBase64: String
    let annotations: [Annotation]
    let comment: String
    let summary: String
    let fields: Fields
}

struct CommentRequest: Encodable { let body: String }
struct SeenRequest: Encodable { let throughSequence: Int }

// MARK: Helpers

func parseISODate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

func relativeTime(_ date: Date?) -> String {
    guard let date else { return "" }
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .abbreviated
    return f.localizedString(for: date, relativeTo: Date())
}
