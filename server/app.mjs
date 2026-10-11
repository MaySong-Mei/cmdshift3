import http from 'node:http';
import { readFile, stat, readdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, extname, sep } from 'node:path';
import { openStore } from './lib/store.mjs';
import { openProjectGit } from './lib/git.mjs';
import { ApiError, fail, text, source, decodePNG, annotations, fields, requestHash, foldState, validCommitId } from './lib/validation.mjs';
import { organizeDeliverable, summarizeProject, providerStatus } from './lib/ai.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const CATCHUP_CACHE_LIMIT = 128;
const CATCHUP_CACHE_TTL = 10 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function json(res, status, value) { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } }
async function body(req, maximum = MAX_BODY) {
  if (Number(req.headers['content-length']) > maximum) fail(413, 'request_too_large', 'Request exceeds the allowed size.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maximum) fail(413, 'request_too_large', 'Request exceeds the allowed size.'); chunks.push(chunk); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'Request must contain valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_json', 'Request must contain a JSON object.');
  return data;
}
function sequence(value, label = 'sequence') { if (!Number.isSafeInteger(value) || value < 0) fail(400, 'invalid_input', `${label} must be a nonnegative integer.`); return value; }
function configuredInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) { if (value === undefined || value === '') return fallback; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('Invalid public limit configuration.'); return number; }
function projectInput(input) {
  const name = text(input.name, 'name', 120, 1).trim();
  if (!name || /[\u0000-\u001f]/.test(name)) fail(400, 'invalid_input', 'Project name must contain visible text.');
  const deadline = text(input.deadline ?? '', 'deadline', 10);
  const date = new Date(`${deadline}T00:00:00Z`);
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== deadline)) fail(400, 'invalid_input', 'Deadline must be a valid YYYY-MM-DD date or empty.');
  return { name, description: text(input.description ?? '', 'description', 2000), context: text(input.context ?? '', 'context', 12000), phase: text(input.phase ?? '', 'phase', 80), deadline };
}
function accountInput(input) {
  if (typeof input.username !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(input.username)) fail(400, 'invalid_input', 'Username must be 3–32 lowercase letters, numbers, underscores or hyphens.');
  const name = text(input.name, 'name', 80, 1).trim();
  if (!name || /[\u0000-\u001f]/.test(name)) fail(400, 'invalid_input', 'Name must contain visible text.');
  if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) fail(400, 'invalid_input', 'Password must be 12–128 characters.');
  return { username: input.username, name, password: input.password };
}
async function diskBytes(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) return 0;
  let bytes = info.blocks === undefined ? info.size : info.blocks * 512;
  if (info.isDirectory()) for (const child of await readdir(directory)) bytes += await diskBytes(join(directory, child));
  return bytes;
}

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.CMD3_DATA_DIR ?? '.data');
  const webDir = resolve(options.webDir ?? new URL('../web/', import.meta.url).pathname);
  const mode = options.mode ?? process.env.CMD3_MODE ?? 'demo';
  if (!['demo','public'].includes(mode)) throw new Error('CMD3_MODE must be demo or public.');
  const publicMode = mode === 'public';
  const limits = {
    requests: configuredInt(options.maxRequests ?? process.env.CMD3_MAX_REQUESTS, 6, 64),
    auth: configuredInt(options.maxAuthConcurrency ?? process.env.CMD3_MAX_AUTH_CONCURRENCY, 3, 8),
    ai: configuredInt(options.maxAIConcurrency ?? process.env.CMD3_MAX_AI_CONCURRENCY, 3, 16),
    aiUser: configuredInt(options.aiUserDaily ?? process.env.CMD3_AI_USER_DAILY_LIMIT, 25),
    aiGlobal: configuredInt(options.aiGlobalDaily ?? process.env.CMD3_AI_GLOBAL_DAILY_LIMIT, 200),
    accounts: configuredInt(options.maxAccounts ?? process.env.CMD3_MAX_ACCOUNTS, 1000),
    signups: configuredInt(options.signupsPerHour ?? process.env.CMD3_SIGNUPS_PER_HOUR, 30),
    projects: configuredInt(options.maxProjects ?? process.env.CMD3_MAX_PROJECTS, 100),
    owned: configuredInt(options.maxOwnedProjects ?? process.env.CMD3_MAX_OWNED_PROJECTS, 5),
    commits: configuredInt(options.projectCommitLimit ?? process.env.CMD3_PROJECT_COMMIT_LIMIT, 1000),
    projectBytes: configuredInt(options.projectStorageBytes ?? process.env.CMD3_PROJECT_STORAGE_BYTES, 20 * 1024 * 1024),
    totalBytes: configuredInt(options.totalStorageBytes ?? process.env.CMD3_TOTAL_STORAGE_BYTES, 300 * 1024 * 1024),
    comments: configuredInt(options.projectCommentLimit ?? process.env.CMD3_PROJECT_COMMENT_LIMIT, 500),
    versions: configuredInt(options.contextVersionLimit ?? process.env.CMD3_CONTEXT_VERSION_LIMIT, 100),
    streams: configuredInt(options.ssePerUser ?? process.env.CMD3_SSE_PER_USER, 4, 16),
  };
  const registration = publicMode && process.env.CMD3_PUBLIC_REGISTRATION !== 'false';
  const allowedOrigins = (process.env.CMD3_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const store = await openStore(dataDir, { mode });
  const repositories = new Map();
  const queues = new Map();
  const streams = new Map();
  const catchupCache = new Map();
  const catchupInFlight = new Map();
  let closing = false;
  let activeRequests = 0; let activeAuth = 0; let activeAI = 0;
  const rateBuckets = new Map();
  function rate(key, count, window) {
    if (!publicMode) return;
    const now = Date.now(); let bucket = rateBuckets.get(key);
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + window }; rateBuckets.set(key, bucket); }
    if (++bucket.count > count) fail(429, 'rate_limited', 'Too many requests. Please try again later.');
    if (rateBuckets.size > 2048) for (const [item, value] of rateBuckets) if (value.until <= now) rateBuckets.delete(item);
    if (rateBuckets.size > 4096) fail(429, 'rate_limited', 'Please try again later.');
  }
  async function authWork(work) { if (publicMode && activeAuth >= limits.auth) fail(429, 'busy', 'Sign-in is busy. Please try again shortly.'); activeAuth++; try { return await work(); } finally { activeAuth--; } }
  async function aiWork(userId, work) {
    if (publicMode && activeAI >= limits.ai) fail(429, 'ai_busy', 'AI is busy. Your work is retained; please try again shortly.');
    activeAI++;
    const beforeModelCall = publicMode ? () => { if (!store.chargeAI(userId, limits.aiUser, limits.aiGlobal)) fail(429, 'ai_quota_exceeded', 'Today’s AI allowance is used. You can still review and commit your work manually.'); } : undefined;
    try { return await work(beforeModelCall); } finally { activeAI--; }
  }
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
    for (const project of store.allProjects()) {
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
    for (const client of streams.get(projectId) ?? []) {
      if (!store.userForToken(client.token) || !store.isMember(client.userId, projectId)) { client.res.end(); continue; }
      if (!client.res.destroyed && !client.res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`)) client.res.end();
    }
  }
  function markRemoteSynced(projectId) {
    for (const commit of store.commits(projectId)) if (!commit.git.remote_synced) { commit.git.remote_synced = true; store.updateCommit(commit); }
  }
  function summarizeWindow(userId, projectId, since, through, commits, state) {
    const ai = providerStatus().ai;
    const project = projectBackground(projectId);
    const key = JSON.stringify([userId, projectId, since, through, project.version, ai.provider, ai.configured]);
    const cached = catchupCache.get(key);
    if (cached && cached.expires > Date.now()) {
      // Refresh insertion order for bounded LRU retention, preserving the original expiry.
      catchupCache.delete(key); catchupCache.set(key, cached);
      return Promise.resolve(cached.result);
    }
    if (cached) catchupCache.delete(key);
    if (catchupInFlight.has(key)) return catchupInFlight.get(key);
    const pending = Promise.resolve().then(() => aiWork(userId, beforeModelCall => summarize({ commits, state, since_sequence: since, through_sequence: through, project_id: projectId, project, beforeModelCall }))).then(result => {
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
  function projectBackground(id) { const project = store.project(id); return Object.fromEntries(['id','name','description','context','phase','deadline','version'].map(key => [key, project[key]])); }
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    let counted = false;
    try {
      if (closing) fail(503, 'shutting_down', 'Server is shutting down.');
      if (publicMode && activeRequests >= limits.requests) fail(429, 'busy', 'The service is busy. Please try again shortly.');
      activeRequests++; counted = true;
      const origin = req.headers.origin;
      if (!publicMode) res.setHeader('Access-Control-Allow-Origin', '*');
      else if (origin) {
        let sameOrigin = false;
        try { const parsed = new URL(origin); sameOrigin = parsed.host === req.headers.host && (parsed.protocol === 'https:' || ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)); } catch { /* Invalid origins are denied. */ }
        if (!sameOrigin && !allowedOrigins.includes(origin)) fail(403, 'origin_not_allowed', 'This web origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      if (publicMode) res.setHeader('X-Frame-Options', 'DENY');
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && path === '/api/health') { json(res, 200, { ok: true, version: '0.2.0', mode, public_registration: registration, git: { provider: 'git', storage: 'per-project repositories', remote: publicMode ? 'persistent server bare origins unless configured' : 'local bare origin unless configured' }, ...providerStatus() }); return; }
      if (req.method === 'POST' && path === '/api/accounts') {
        if (!registration) fail(403, 'registration_disabled', 'Public registration is not enabled.');
        rate('auth:global', 500, 10 * 60 * 1000); rate(`auth:${req.socket.remoteAddress}`, 120, 10 * 60 * 1000);
        const input = accountInput(await body(req, 16 * 1024));
        const result = await authWork(() => store.createAccount(input.username, input.name, input.password, limits.accounts, limits.signups));
        if (result.error === 'duplicate') fail(409, 'username_unavailable', 'This username is unavailable.');
        if (result.error) fail(429, 'registration_limit', 'Registration is temporarily full. Please try again later.');
        json(res, 201, result.session); return;
      }
      if (req.method === 'POST' && path === '/api/session') {
        rate('auth:global', 500, 10 * 60 * 1000); rate(`auth:${req.socket.remoteAddress}`, 120, 10 * 60 * 1000);
        const input = await body(req, 4096);
        let session;
        if (Object.hasOwn(input, 'username') || Object.hasOwn(input, 'password')) {
          if (typeof input.username !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(input.username) || typeof input.password !== 'string' || input.password.length > 128) fail(401, 'invalid_credentials', 'Username or password is incorrect.');
          session = await authWork(() => store.passwordSession(input.username, input.password));
        } else session = store.createSession(input.code);
        if (!session) fail(401, 'invalid_credentials', publicMode ? 'Username, password or Mac connection code is incorrect.' : 'Use a valid login code or account.');
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
      if (req.method === 'POST' && path !== '/api/commits') {
        rate(`write:${user.id}`, 60, 60 * 1000);
        if (publicMode && !['/api/session/logout','/api/draft'].includes(path) && await diskBytes(dataDir) + 64 * 1024 > limits.totalBytes) fail(507, 'storage_limit', 'The service storage allowance is full.');
      }
      if (req.method === 'POST' && path === '/api/me/access-code') { json(res, 200, store.rotateAccessCode(user.id)); return; }
      if (req.method === 'GET' && path === '/api/projects') { json(res, 200, { projects: store.projectsFor(user.id) }); return; }
      if (req.method === 'POST' && path === '/api/projects') {
        const input = projectInput(await body(req, 64 * 1024));
        const project = await serialized('project:create', async () => {
          if (publicMode && (store.ownedCount(user.id) >= limits.owned || store.allProjects().length >= limits.projects)) fail(429, 'project_limit', 'The project limit has been reached. Join an existing project or try again later.');
          if (publicMode && await diskBytes(dataDir) + 1024 * 1024 > limits.totalBytes) fail(507, 'storage_limit', 'The service storage allowance is full.');
          const id = `proj_${randomUUID()}`;
          const repo = await openProjectGit(dataDir, id);
          const created = store.createProject(id, user, input); repositories.set(id, repo);
          return created;
        });
        json(res, 201, { project }); return;
      }
      if (req.method === 'POST' && path === '/api/projects/join') {
        const input = await body(req, 1024); const code = text(input.code, 'invite code', 128, 1);
        const project = store.joinProject(user.id, code);
        if (!project) fail(404, 'invalid_invite', 'This invitation is invalid or has expired.');
        emit(project.id, { type: 'membership', project_id: project.id, sequence: store.sequence(project.id) });
        json(res, 200, { project }); return;
      }
      const contextMatch = path.match(/^\/api\/projects\/([^/]+)\/(context|invite)$/);
      if (contextMatch) {
        const [, projectId, operation] = contextMatch; membership(user, projectId);
        if (operation === 'context' && req.method === 'GET') { json(res, 200, store.projectContext(projectId)); return; }
        if (req.method === 'POST') {
          if (store.project(projectId).owner_id !== user.id) fail(403, 'owner_required', 'Only the project owner can change its background or invitations.');
          if (operation === 'invite') { json(res, 200, store.rotateInvite(projectId)); return; }
          const input = await body(req, 64 * 1024); const normalized = projectInput(input);
          if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) fail(400, 'invalid_input', 'expected_version must be a positive integer.');
          if (publicMode && store.project(projectId).version >= limits.versions) fail(507, 'context_version_limit', 'This project’s background history allowance is full. Existing versions are preserved.');
          const project = store.updateContext(projectId, user, normalized, input.expected_version);
          if (!project) fail(409, 'version_conflict', 'Project background changed. Refresh it before saving again.');
          emit(projectId, { type: 'context', project_id: projectId, version: project.version, sequence: store.sequence(projectId) });
          json(res, 200, { project }); return;
        }
      }
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
        const draft = await aiWork(user.id, beforeModelCall => organize({ project_id: input.project_id, project: projectBackground(input.project_id), actor: { id: user.id, name: user.name }, comment, source: captureSource, image_base64: input.image_base64, state, beforeModelCall }));
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
        const result = await serialized(`commit:${input.id}`, () => serialized(publicMode ? 'commit:storage' : `storage:${input.id}`, () => serialized(input.project_id, async () => {
          const previous = store.getCommit(input.id);
          if (previous) {
            if (previous.hash !== hash || previous.commit.project_id !== input.project_id || previous.userId !== user.id) fail(409, 'idempotency_conflict', 'Commit ID was already used with different input.');
            if (!previous.commit.git.remote_synced && await repositories.get(input.project_id).push()) {
              markRemoteSynced(input.project_id); previous.commit.git.remote_synced = true;
            }
            return { status: 200, commit: previous.commit };
          }
          rate(`commit:${user.id}`, 30, 60 * 1000);
          const image = decodePNG(input.image_base64);
          const normalizedFields = fields(input.fields, store.commits(input.project_id));
          const commit = {
            id: input.id, project_id: input.project_id,
            source: source(input.source), comment: text(input.comment ?? '', 'comment', 8000),
            summary: text(input.summary ?? '', 'summary', 4000, 1), fields: normalizedFields,
            author: { id: user.id, name: user.name }, created_at: new Date().toISOString(),
            sequence: store.sequence(input.project_id) + 1,
            evidence: { image_url: `/api/evidence/${input.id}`, annotations: annotations(input.annotations), ...(publicMode ? { image_bytes: image.length } : {}) },
          };
          if (publicMode) {
            const anticipated = (image.length + Buffer.byteLength(JSON.stringify(commit))) * 3 + 64 * 1024;
            if (store.projectUsage(input.project_id).commits >= limits.commits || await diskBytes(join(dataDir, 'projects', input.project_id)) + anticipated > limits.projectBytes) fail(507, 'project_storage_limit', 'This project’s work storage allowance is full. Existing work and retries are preserved.');
            if (await diskBytes(dataDir) + anticipated > limits.totalBytes) fail(507, 'storage_limit', 'The service storage allowance is full. Existing work and retries are preserved.');
          }
          const manifest = { ...commit, _request_hash: hash };
          commit.git = await repositories.get(input.project_id).writeCommit(manifest, image);
          try { store.insertCommit(commit, hash); } catch (error) { await reconcile(input.project_id); if (!store.getCommit(commit.id)) throw error; }
          if (commit.git.remote_synced) markRemoteSynced(input.project_id);
          emit(input.project_id, { type: 'commit', project_id: input.project_id, commit_id: commit.id, sequence: commit.sequence });
          if (options.onCommit) Promise.resolve().then(() => options.onCommit(commit)).catch(() => {});
          return { status: 201, commit };
        })));
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
          const input = await body(req, 16 * 1024);
          if (publicMode && store.commentCount(commit.project_id) >= limits.comments) fail(507, 'comment_limit', 'This project’s discussion allowance is full.');
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
          const input = await body(req, 1024); const seen = sequence(input.through_sequence, 'through_sequence');
          if (seen > through) fail(400, 'invalid_input', 'Cannot mark unseen future commits as read.');
          json(res, 200, { seen_sequence: store.markSeen(user.id, projectId, seen) }); return;
        }
        if (req.method === 'GET' && operation === 'events') {
          if (publicMode && [...streams.values()].reduce((count, clients) => count + [...clients].filter(client => client.userId === user.id).length, 0) >= limits.streams) fail(429, 'stream_limit', 'Too many live project views are open. Close another view and try again.');
          if (publicMode && [...streams.values()].reduce((count, clients) => count + clients.size, 0) >= 200) fail(429, 'stream_limit', 'Live updates are busy. Refresh the project shortly.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`event: ready\ndata: ${JSON.stringify({ project_id: projectId, through_sequence: through })}\n\n`);
          const client = { res, token, userId: user.id, timer: setInterval(() => { if (!store.userForToken(token) || !store.isMember(user.id, projectId)) { res.end(); return; } if (!res.destroyed && !res.write(': heartbeat\n\n')) res.end(); }, options.sseHeartbeatMs ?? 15000) };
          client.timer.unref();
          if (!streams.has(projectId)) streams.set(projectId, new Set()); streams.get(projectId).add(client);
          res.on('close', () => { clearInterval(client.timer); streams.get(projectId)?.delete(client); }); return;
        }
      }
      fail(404, 'not_found', 'Route does not exist.');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Request failed: internal operation error.');
      if (error instanceof ApiError && error.status === 429) res.setHeader('Retry-After', '60');
      json(res, error instanceof ApiError ? error.status : 500, { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.message : 'The operation failed. Your existing commits are preserved.' } });
    } finally { if (counted) activeRequests--; }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  if (publicMode) server.maxConnections = 256;
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
