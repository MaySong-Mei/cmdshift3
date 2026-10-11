import Foundation

struct APIError: LocalizedError {
    let status: Int
    let code: String
    let message: String

    var errorDescription: String? {
        status == 0 ? message : "\(message) [\(code), HTTP \(status)]"
    }
}

/// Thin client for docs/API.md v1. Bearer token comes from the demo login code.
final class APIClient: @unchecked Sendable {
    var baseURL: URL
    var token: String?

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    func send<T: Decodable>(_ method: String, _ path: String, body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        let (data, status) = try await raw(method, path, body: body)
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: status, code: "decode", message: "Unexpected response for \(method) \(path): \(error)")
        }
    }

    func raw(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws -> (Data, Int) {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError(status: 0, code: "url", message: "Bad URL: \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 90
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = try Self.encoder.encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError(status: 0, code: "network", message: "Cannot reach \(baseURL.absoluteString) — \(error.localizedDescription)")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let e = try? Self.decoder.decode(ErrorEnvelope.self, from: data) {
                throw APIError(status: status, code: e.error.code, message: e.error.message)
            }
            let text = String(data: data, encoding: .utf8) ?? ""
            throw APIError(status: status, code: "http", message: text.isEmpty ? "HTTP \(status)" : String(text.prefix(300)))
        }
        return (data, status)
    }

    // MARK: Endpoints

    func session(code: String) async throws -> SessionResponse {
        try await send("POST", "/api/session", body: SessionRequest(code: code))
    }

    func me() async throws -> MeResponse { try await send("GET", "/api/me") }

    func logout() async { _ = try? await raw("POST", "/api/session/logout") }

    func draft(_ req: DraftRequest) async throws -> DraftResponse {
        try await send("POST", "/api/draft", body: req)
    }

    func commit(_ req: CommitRequest) async throws -> WorkCommit {
        try await send("POST", "/api/commits", body: req, as: CommitEnvelope.self).commit
    }

    func commits(project: String) async throws -> CommitsResponse {
        try await send("GET", "/api/projects/\(project)/commits?since_sequence=0")
    }

    func state(project: String) async throws -> StateResponse {
        try await send("GET", "/api/projects/\(project)/state")
    }

    func context(project: String) async throws -> ProjectContextResponse {
        try await send("GET", "/api/projects/\(project)/context")
    }

    func catchup(project: String) async throws -> CatchupResponse {
        try await send("GET", "/api/projects/\(project)/catchup")
    }

    func seen(project: String, through: Int) async throws -> SeenResponse {
        try await send("POST", "/api/projects/\(project)/seen", body: SeenRequest(throughSequence: through))
    }

    func comments(commit: String) async throws -> [Comment] {
        try await send("GET", "/api/commits/\(commit)/comments", as: CommentsResponse.self).comments
    }

    func addComment(commit: String, body: String) async throws -> Comment {
        try await send("POST", "/api/commits/\(commit)/comments", body: CommentRequest(body: body), as: CommentEnvelope.self).comment
    }

    func imageData(path: String) async throws -> Data {
        try await raw("GET", path).0
    }
}
