import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { openStore, PROJECTS } from './lib/store.mjs';
import { openProjectGit } from './lib/git.mjs';
import { ApiError, fail, text, source, decodePNG, annotations, fields, requestHash, foldState, validCommitId } from './lib/validation.mjs';
import { organizeDeliverable, summarizeProject, providerStatus } from './lib/ai.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const CATCHUP_CACHE_LIMIT = 128;
const CATCHUP_CACHE_TTL = 10 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function json(res, status, value) { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } }
async function body(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) fail(413, 'request_too_large', 'Request exceeds 12 MiB.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail(413, 'request_too_large', 'Request exceeds 12 MiB.'); chunks.push(chunk); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'Request must contain valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_json', 'Request must contain a JSON object.');
  return data;
}
function sequence(value, label = 'sequence') { if (!Number.isSafeInteger(value) || value < 0) fail(400, 'invalid_input', `${label} must be a nonnegative integer.`); return value; }

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.CMD3_DATA_DIR ?? '.data');
  const webDir = resolve(options.webDir ?? new URL('../web/', import.meta.url).pathname);
  const store = await openStore(dataDir);
  const repositories = new Map();
  const queues = new Map();
  const streams = new Map();
  const catchupCache = new Map();
  const catchupInFlight = new Map();
  let closing = false;
  const organize = options.organizeDeliverable ?? organizeDeliverable;
  const summarize = options.summarizeProject ?? summarizeProject;

  async function reconcile(projectId) {
    const repo = repositories.get(projectId);
    for (const { commit, hash } of await repo.manifests()) {
      if (commit.project_id !== projectId || !validCommitId(commit.id) || !hash) throw new Error('Invalid Git deliverable manifest.');
      const previous = store.getCommit(commit.id);
      if (!previous) store.insertCommit(commit, hash);
      else if (previous.commit.git.sha === commit.git.sha) store.updateCommit(commit);
      else throw new Error('Conflicting Git deliverable history.');
    }
  }
  try {
    for (const project of PROJECTS) {
      const remote = options.remotes?.[project.id] ?? process.env[`CMD3_REMOTE_${project.id.toUpperCase()}`];
      repositories.set(project.id, await openProjectGit(dataDir, project.id, remote));
      await reconcile(project.id);
    }
  } catch (error) { store.close(); throw error; }
  function serialized(projectId, work) {
    const previous = queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(projectId, next);
    next.finally(() => { if (queues.get(projectId) === next) queues.delete(projectId); }).catch(() => {});
    return next;
  }
  function membership(user, projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) fail(400, 'invalid_input', 'A project_id string is required.');
    if (!store.hasProject(projectId)) fail(404, 'not_found', 'Project does not exist.');
    if (!store.isMember(user.id, projectId)) fail(403, 'forbidden', 'You are not a member of this project.');
  }
  function getCommit(user, id) {
    const row = store.getCommit(id);
    if (!row) fail(404, 'not_found', 'Commit does not exist.');
    membership(user, row.commit.project_id);
    return row;
  }
  function emit(projectId, event) {
    for (const client of streams.get(projectId) ?? []) if (!client.res.destroyed) client.res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
  }
  function markRemoteSynced(projectId) {
    for (const commit of store.commits(projectId)) if (!commit.git.remote_synced) { commit.git.remote_synced = true; store.updateCommit(commit); }
  }
  function summarizeWindow(userId, projectId, since, through, commits, state) {
    const ai = providerStatus().ai;
    const key = JSON.stringify([userId, projectId, since, through, ai.provider, ai.configured]);
    const cached = catchupCache.get(key);
    if (cached && cached.expires > Date.now()) {
      // Refresh insertion order for bounded LRU retention, preserving the original expiry.
      catchupCache.delete(key); catchupCache.set(key, cached);
      return Promise.resolve(cached.result);
    }
    if (cached) catchupCache.delete(key);
    if (catchupInFlight.has(key)) return catchupInFlight.get(key);
    const pending = Promise.resolve().then(() => summarize({ commits, state, since_sequence: since, through_sequence: through, project_id: projectId })).then(result => {
      const analyzer = result?.analyzer;
      const cacheable = typeof result?.summary === 'string' && (
        (analyzer?.provider === 'manual' && analyzer.status === 'not_configured') ||
        (typeof analyzer?.provider === 'string' && analyzer.provider !== 'manual' && analyzer.status === 'completed')
      );
      if (cacheable) {
        catchupCache.set(key, { result, expires: Date.now() + CATCHUP_CACHE_TTL });
        while (catchupCache.size > CATCHUP_CACHE_LIMIT) catchupCache.delete(catchupCache.keys().next().value);
      }
      return result;
    });
    catchupInFlight.set(key, pending);
    pending.finally(() => { if (catchupInFlight.get(key) === pending) catchupInFlight.delete(key); }).catch(() => {});
    return pending;
  }
  async function staticFile(path, res) {
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { fail(400, 'invalid_input', 'Invalid URL.'); }
    const file = resolve(webDir, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (file !== webDir && !file.startsWith(`${webDir}${sep}`)) fail(404, 'not_found', 'File does not exist.');
    let data;
    try { if (!(await stat(file)).isFile()) fail(404, 'not_found', 'File does not exist.'); data = await readFile(file); } catch { fail(404, 'not_found', 'File does not exist.'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Native clients and separately hosted demo dashboards may connect to the same service.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    try {
      if (closing) fail(503, 'shutting_down', 'Server is shutting down.');
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && path === '/api/health') { json(res, 200, { ok: true, version: '0.1.0', mode: 'demo', git: { provider: 'git', storage: 'per-project repositories', remote: 'local bare origin unless configured' }, ...providerStatus() }); return; }
      if (req.method === 'POST' && path === '/api/session') {
        const input = await body(req);
        const session = store.createSession(input.code);
        if (!session) fail(401, 'invalid_code', 'Use a valid demo login code.');
        json(res, 200, session); return;
      }
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') fail(405, 'method_not_allowed', 'This route only supports GET.');
        await staticFile(path, res); return;
      }
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      const user = token ? store.userForToken(token) : null;
      if (!user) fail(401, 'unauthorized', 'A valid bearer session is required.');
      if (req.method === 'GET' && path === '/api/me') { json(res, 200, { user, projects: store.projectsFor(user.id) }); return; }
      if (req.method === 'GET' && path === '/api/projects') { json(res, 200, { projects: store.projectsFor(user.id) }); return; }
      if (req.method === 'POST' && path === '/api/session/logout') {
        store.revoke(token);
        for (const clients of streams.values()) for (const client of clients) if (client.token === token) { clearInterval(client.timer); client.res.end(); clients.delete(client); }
        json(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && path === '/api/draft') {
        const input = await body(req); membership(user, input.project_id);
        const comment = text(input.comment ?? '', 'comment', 8000);
        const captureSource = source(input.source);
        if (input.image_base64 !== undefined) decodePNG(input.image_base64);
        const state = foldState(store.commits(input.project_id));
        const draft = await organize({ project_id: input.project_id, actor: { id: user.id, name: user.name }, comment, source: captureSource, image_base64: input.image_base64, state });
        json(res, 200, draft); return;
      }
      if (req.method === 'POST' && path === '/api/commits') {
        const input = await body(req); membership(user, input.project_id);
        if (!validCommitId(input.id)) fail(400, 'invalid_input', 'A stable wc_<uuid> commit ID is required.');
        // Hash only client-owned contract fields; submitted identity and server metadata never change the actor.
        const clientPayload = Object.fromEntries(['id','project_id','source','image_base64','annotations','comment','summary','fields'].map(key => [key, input[key]]));
        const hash = requestHash(clientPayload, user.id);
        // IDs are globally unique even when a client changes projects during a retry.
        // Always acquire the ID lock before the project lock, so the dependency order cannot cycle.
        const result = await serialized(`commit:${input.id}`, () => serialized(input.project_id, async () => {
          const previous = store.getCommit(input.id);
          if (previous) {
            if (previous.hash !== hash || previous.commit.project_id !== input.project_id || previous.userId !== user.id) fail(409, 'idempotency_conflict', 'Commit ID was already used with different input.');
            if (!previous.commit.git.remote_synced && await repositories.get(input.project_id).push()) {
              markRemoteSynced(input.project_id); previous.commit.git.remote_synced = true;
            }
            return { status: 200, commit: previous.commit };
          }
          const image = decodePNG(input.image_base64);
          const normalizedFields = fields(input.fields, store.commits(input.project_id));
          const commit = {
            id: input.id, project_id: input.project_id,
            source: source(input.source), comment: text(input.comment ?? '', 'comment', 8000),
            summary: text(input.summary ?? '', 'summary', 4000, 1), fields: normalizedFields,
            author: { id: user.id, name: user.name }, created_at: new Date().toISOString(),
            sequence: store.sequence(input.project_id) + 1,
            evidence: { image_url: `/api/evidence/${input.id}`, annotations: annotations(input.annotations) },
          };
          const manifest = { ...commit, _request_hash: hash };
          commit.git = await repositories.get(input.project_id).writeCommit(manifest, image);
          try { store.insertCommit(commit, hash); } catch (error) { await reconcile(input.project_id); if (!store.getCommit(commit.id)) throw error; }
          if (commit.git.remote_synced) markRemoteSynced(input.project_id);
          emit(input.project_id, { type: 'commit', project_id: input.project_id, commit_id: commit.id, sequence: commit.sequence });
          if (options.onCommit) Promise.resolve().then(() => options.onCommit(commit)).catch(() => {});
          return { status: 201, commit };
        }));
        json(res, result.status, { commit: result.commit }); return;
      }
      let match = path.match(/^\/api\/evidence\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const { commit } = getCommit(user, match[1]);
        const image = await repositories.get(commit.project_id).readCapture(commit);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' }); res.end(image); return;
      }
      match = path.match(/^\/api\/commits\/([^/]+)(\/comments)?$/);
      if (match) {
        const { commit } = getCommit(user, match[1]);
        if (req.method === 'GET' && !match[2]) { json(res, 200, { commit }); return; }
        if (req.method === 'GET' && match[2]) { json(res, 200, { comments: store.comments(commit.id) }); return; }
        if (req.method === 'POST' && match[2]) {
          const input = await body(req);
          const comment = store.addComment(commit, user, text(text(input.body, 'comment body', 4000, 1).trim(), 'comment body', 4000, 1));
          emit(commit.project_id, { type: 'comment', project_id: commit.project_id, commit_id: commit.id, sequence: store.sequence(commit.project_id) });
          json(res, 201, { comment }); return;
        }
      }
      match = path.match(/^\/api\/projects\/([^/]+)\/(commits|state|catchup|seen|events)$/);
      if (match) {
        const [, projectId, operation] = match; membership(user, projectId);
        const through = store.sequence(projectId);
        if (req.method === 'GET' && operation === 'commits') {
          const since = sequence(Number(url.searchParams.get('since_sequence') ?? 0), 'since_sequence');
          json(res, 200, { commits: store.commits(projectId, since), through_sequence: through }); return;
        }
        if (req.method === 'GET' && operation === 'state') { json(res, 200, { state: foldState(store.commits(projectId)), through_sequence: through }); return; }
        if (req.method === 'GET' && operation === 'catchup') {
          const since = store.seen(user.id, projectId);
          const all = store.commits(projectId).filter(commit => commit.sequence <= through); const commits = all.filter(commit => commit.sequence > since);
          const state = foldState(all);
          const result = await summarizeWindow(user.id, projectId, since, through, commits, state);
          json(res, 200, { since_sequence: since, through_sequence: through, commits, summary: result.summary, state, analyzer: result.analyzer, evidence: commits.map(commit => ({ commit_id: commit.id, git_sha: commit.git.sha })) }); return;
        }
        if (req.method === 'POST' && operation === 'seen') {
          const input = await body(req); const seen = sequence(input.through_sequence, 'through_sequence');
          if (seen > through) fail(400, 'invalid_input', 'Cannot mark unseen future commits as read.');
          json(res, 200, { seen_sequence: store.markSeen(user.id, projectId, seen) }); return;
        }
        if (req.method === 'GET' && operation === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`event: ready\ndata: ${JSON.stringify({ project_id: projectId, through_sequence: through })}\n\n`);
          const client = { res, token, timer: setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000) };
          client.timer.unref();
          if (!streams.has(projectId)) streams.set(projectId, new Set()); streams.get(projectId).add(client);
          res.on('close', () => { clearInterval(client.timer); streams.get(projectId)?.delete(client); }); return;
        }
      }
      fail(404, 'not_found', 'Route does not exist.');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Request failed:', error.message);
      json(res, error instanceof ApiError ? error.status : 500, { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.message : 'The operation failed. Your existing commits are preserved.' } });
    }
  });
  server.requestTimeout = 30_000;
  return {
    server, store, dataDir,
    async listen(port = 0, host = '127.0.0.1') { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); done(); }); }); return server.address(); },
    async close() {
      if (closing) return; closing = true;
      for (const clients of streams.values()) for (const client of clients) { clearInterval(client.timer); client.res.end(); }
      await Promise.allSettled([...queues.values()]);
      if (server.listening) await new Promise(done => server.close(done));
      await Promise.allSettled([...catchupInFlight.values()]);
      catchupCache.clear(); catchupInFlight.clear();
      store.close();
    },
  };
}
