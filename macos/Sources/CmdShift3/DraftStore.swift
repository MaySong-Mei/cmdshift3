import AppKit
import CryptoKit
import Foundation

/// The frozen Commit payload minus the image (rebuilt from the stored PNG), so a
/// retry after a restart resends exactly the same id and content.
struct FrozenCommit: Codable, Hashable {
    let id: String
    let projectId: String
    let source: Source
    let annotations: [Annotation]
    let comment: String
    let summary: String
    let fields: Fields

    init(_ r: CommitRequest) {
        id = r.id; projectId = r.projectId; source = r.source; annotations = r.annotations
        comment = r.comment; summary = r.summary; fields = r.fields
    }

    func request(png: Data) -> CommitRequest {
        CommitRequest(id: id, projectId: projectId, source: source, imageBase64: png.base64EncodedString(),
                      annotations: annotations, comment: comment, summary: summary, fields: fields)
    }
}

/// One pre-commit capture on disk: `capture.png` + this metadata (`draft.json`).
/// Never contains a bearer token, Mac code or password.
struct StoredDraft: Codable, Identifiable, Hashable {
    static let currentVersion = 1

    var version = StoredDraft.currentVersion
    let id: String                 // stable inbox id (independent of commitId)
    let createdAt: Date
    var updatedAt: Date
    let endpoint: String
    let userId: String
    var projectId: String
    let source: Source
    var commitId: String
    var annotations: [Annotation]
    var comment: String
    var summary: String
    var fields: Fields
    var organizer: Provider?
    var warnings: [String]
    var aiFailure: String?
    var manualReview: Bool
    /// The input (project + trimmed comment) the shown AI draft was written for.
    var appliedProjectId: String?
    var appliedComment: String?
    var drafted: [String: String]
    var draftedSummary: String?
    var frozen: FrozenCommit?
    var lastError: String?

    /// Short status for the inbox list.
    var statusLabel: String {
        if frozen != nil { return lastError == nil ? "Committing — retry if needed" : "Commit failed — retry" }
        if aiFailure != nil || organizer?.mode == .unavailable { return "AI couldn't write — review" }
        if manualReview { return "Manual review" }
        if appliedComment != nil, organizer?.mode == .ai {
            let current = comment.trimmingCharacters(in: .whitespacesAndNewlines)
            return (appliedComment == current && appliedProjectId == projectId) ? "Ready to review" : "Needs update"
        }
        if organizer?.mode == .notConfigured { return "No AI — review manually" }
        return "Not drafted yet"
    }

    var title: String {
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty { return s }
        let c = comment.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return c.isEmpty ? "Capture from \(source.appName)" : c
    }
}

/// Durable local inbox of captures that have not been committed yet.
/// Layout: <root>/<sha256(endpoint|userId)>/<draftId>/{capture.png,draft.json}.
/// Accounts and servers never share a folder; the inbox view filters by project.
final class DraftStore: @unchecked Sendable {
    let root: URL
    /// Metadata larger than this is treated as corrupt and skipped (bounded).
    static let maxMetadataBytes = 2_000_000

    init(root: URL) { self.root = root }

    /// The real per-user location. Isolated launches (selftest/preview) must not use it.
    static func live() -> DraftStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return DraftStore(root: base.appendingPathComponent("CmdShift3/Drafts", isDirectory: true))
    }

    static func scopeKey(endpoint: String, userId: String) -> String {
        let normalized = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let digest = SHA256.hash(data: Data("\(normalized)|\(userId)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    private func folder(endpoint: String, userId: String) -> URL {
        root.appendingPathComponent(Self.scopeKey(endpoint: endpoint, userId: userId), isDirectory: true)
    }

    private func folder(for d: StoredDraft) -> URL {
        folder(endpoint: d.endpoint, userId: d.userId).appendingPathComponent(d.id, isDirectory: true)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; e.dateEncodingStrategy = .iso8601; return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    /// Atomically writes metadata (and the PNG once). Directory is user-only.
    func save(_ draft: StoredDraft, png: Data?) throws {
        let dir = folder(for: draft)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let pngURL = dir.appendingPathComponent("capture.png")
        if let png, !FileManager.default.fileExists(atPath: pngURL.path) {
            try png.write(to: pngURL, options: [.atomic])
        }
        var d = draft
        d.updatedAt = Date()
        try Self.encoder.encode(d).write(to: dir.appendingPathComponent("draft.json"), options: [.atomic])
    }

    /// This account's drafts on this server, newest first. Corrupt or foreign entries are skipped.
    func list(endpoint: String, userId: String) -> [StoredDraft] {
        let dir = folder(endpoint: endpoint, userId: userId)
        guard let ids = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return ids.compactMap { id -> StoredDraft? in
            let meta = dir.appendingPathComponent(id).appendingPathComponent("draft.json")
            guard let data = try? Data(contentsOf: meta), data.count <= Self.maxMetadataBytes,
                  let d = try? Self.decoder.decode(StoredDraft.self, from: data),
                  d.version <= StoredDraft.currentVersion, d.id == id, d.userId == userId,
                  Self.scopeKey(endpoint: d.endpoint, userId: d.userId) == Self.scopeKey(endpoint: endpoint, userId: userId),
                  FileManager.default.fileExists(atPath: dir.appendingPathComponent(id).appendingPathComponent("capture.png").path)
            else { return nil }
            return d
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func png(for d: StoredDraft) -> Data? {
        try? Data(contentsOf: folder(for: d).appendingPathComponent("capture.png"))
    }

    func remove(_ d: StoredDraft) {
        try? FileManager.default.removeItem(at: folder(for: d))
    }
}
