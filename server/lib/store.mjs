import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const PROJECTS = [
  { id: 'proj_cmdshift3', name: 'CmdShift3', description: 'Commit your work. Everyone stays caught up.' },
  { id: 'proj_research', name: 'Research Lab', description: 'Private research workspace · May only' },
];
const USERS = [{ id: 'usr_may', name: 'May', code: 'may-demo' }, { id: 'usr_gary', name: 'Gary', code: 'gary-demo' }];
const digest = value => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const nowISO = () => new Date().toISOString();

export async function openStore(dataDir, { mode = 'demo' } = {}) {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'db.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (user_id TEXT REFERENCES users(id), project_id TEXT REFERENCES projects(id), PRIMARY KEY(user_id, project_id));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commit_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, record_json TEXT NOT NULL, request_hash TEXT NOT NULL, user_id TEXT NOT NULL, UNIQUE(project_id, sequence));
    CREATE INDEX IF NOT EXISTS commits_project ON commit_records(project_id, sequence);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, commit_id TEXT NOT NULL, project_id TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS comments_commit ON comments(commit_id, created_at);
    CREATE TABLE IF NOT EXISTS seen (user_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(user_id, project_id));
    CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY REFERENCES users(id), username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_codes (user_id TEXT PRIMARY KEY REFERENCES users(id), code_hash TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS project_invites (project_id TEXT PRIMARY KEY REFERENCES projects(id), code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_history (project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(project_id,version));
    CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, user_id TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day,user_id));
    CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
  `);
  function addColumn(table, name, definition) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  for (const [name, definition] of [['owner_id', "TEXT NOT NULL DEFAULT ''"], ['context', "TEXT NOT NULL DEFAULT ''"], ['phase', "TEXT NOT NULL DEFAULT ''"], ['deadline', "TEXT NOT NULL DEFAULT ''"], ['version', 'INTEGER NOT NULL DEFAULT 1'], ['updated_at', "TEXT NOT NULL DEFAULT ''"]]) addColumn('projects', name, definition);
  addColumn('sessions', 'expires_at', "TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+30 days') WHERE expires_at=''").run();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowISO());
  db.prepare('DELETE FROM ai_usage WHERE day<?').run(new Date(Date.now() - 60 * 86400000).toISOString().slice(0,10));
  db.prepare('DELETE FROM counters WHERE key<?').run(`signup:${new Date(Date.now() - 7 * 86400000).toISOString().slice(0,13)}`);
  // Accidentally pointing a public deployment at local demo data must never expose it.
  if (mode === 'public' && db.prepare("SELECT id FROM users WHERE id IN ('usr_may','usr_gary') LIMIT 1").get()) { db.close(); throw new Error('Public mode requires a separate data directory without local demo accounts.'); }
  if (mode !== 'public') {
    for (const user of USERS) db.prepare('INSERT OR IGNORE INTO users (id,name) VALUES (?, ?)').run(user.id, user.name);
    for (const project of PROJECTS) db.prepare('INSERT OR IGNORE INTO projects (id,name,description,owner_id,updated_at) VALUES (?, ?, ?, ?, ?)').run(project.id, project.name, project.description, 'usr_may', nowISO());
    db.prepare("UPDATE projects SET owner_id='usr_may', updated_at=? WHERE owner_id='' AND id IN ('proj_cmdshift3','proj_research')").run(nowISO());
    for (const [user, project] of [['usr_may', 'proj_cmdshift3'], ['usr_gary', 'proj_cmdshift3'], ['usr_may', 'proj_research']]) db.prepare('INSERT OR IGNORE INTO memberships VALUES (?, ?)').run(user, project);
  }
  function transaction(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function snapshot(project, actor) { return { version: project.version, context: project.context, name: project.name, description: project.description, phase: project.phase, deadline: project.deadline, updated_at: project.updated_at, updated_by: { id: actor.id, name: actor.name } }; }
  const projectSelect = 'SELECT projects.*, (SELECT COUNT(*) FROM memberships WHERE project_id=projects.id) AS member_count FROM projects';
  const api = {
    db,
    issueSession(user) {
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowISO());
      // Retain a bounded number of device sessions; only token digests are stored.
      db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 19)').run(user.id);
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?, ?, ?, ?)').run(digest(token), user.id, nowISO(), new Date(Date.now() + SESSION_MS).toISOString());
      return { token, user: { id: user.id, name: user.name }, projects: this.projectsFor(user.id) };
    },
    createSession(code) {
      if (typeof code !== 'string' || code.length > 128) return null;
      const demo = mode !== 'public' ? USERS.find(item => item.code === code) : null;
      const user = demo ?? db.prepare('SELECT users.id,users.name FROM access_codes JOIN users ON users.id=access_codes.user_id WHERE code_hash=?').get(digest(code));
      return user ? this.issueSession(user) : null;
    },
    async createAccount(username, name, password, maxAccounts = 1000, signupLimit = 30) {
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt, 64)).toString('hex');
      const user = { id: `usr_${randomUUID()}`, name };
      const result = transaction(() => {
        if (db.prepare('SELECT user_id FROM credentials WHERE username=?').get(username)) return 'duplicate';
        if (db.prepare('SELECT COUNT(*) AS count FROM credentials').get().count >= maxAccounts) return 'full';
        const key = `signup:${new Date().toISOString().slice(0, 13)}`;
        if ((db.prepare('SELECT count FROM counters WHERE key=?').get(key)?.count ?? 0) >= signupLimit) return 'rate';
        db.prepare('INSERT INTO users (id,name) VALUES (?,?)').run(user.id, user.name);
        db.prepare('INSERT INTO credentials VALUES (?,?,?,?)').run(user.id, username, salt, hash);
        db.prepare('INSERT INTO counters VALUES (?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key);
        return 'created';
      });
      return result === 'created' ? { session: this.issueSession(user) } : { error: result };
    },
    async passwordSession(username, password) {
      const row = db.prepare('SELECT credentials.*,users.name FROM credentials JOIN users ON users.id=credentials.user_id WHERE username=?').get(username);
      // Missing users take the same expensive path to reduce account enumeration by timing.
      const actual = await derive(password, row?.salt ?? '00000000000000000000000000000000', 64);
      const expected = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
      return row && timingSafeEqual(actual, expected) ? this.issueSession({ id: row.user_id, name: row.name }) : null;
    },
    rotateAccessCode(userId) { const code = `mac_${randomBytes(24).toString('base64url')}`; db.prepare('INSERT INTO access_codes VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash').run(userId, digest(code)); return { code }; },
    userForToken(token) { return db.prepare('SELECT users.id, users.name FROM sessions JOIN users ON sessions.user_id=users.id WHERE token_hash=? AND expires_at>?').get(digest(token), nowISO()); },
    revoke(token) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); },
    projectsFor(userId) { return db.prepare(`${projectSelect} WHERE projects.id IN (SELECT project_id FROM memberships WHERE user_id=?) ORDER BY projects.id`).all(userId); },
    allProjects() { return db.prepare(`${projectSelect} ORDER BY projects.id`).all(); },
    project(id) { return db.prepare(`${projectSelect} WHERE projects.id=?`).get(id); },
    hasProject(projectId) { return Boolean(db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)); },
    isMember(userId, projectId) { return Boolean(db.prepare('SELECT user_id FROM memberships WHERE user_id=? AND project_id=?').get(userId, projectId)); },
    ownedCount(userId) { return db.prepare('SELECT COUNT(*) AS count FROM projects WHERE owner_id=?').get(userId).count; },
    createProject(id, actor, input) {
      return transaction(() => {
        db.prepare('INSERT INTO projects (id,name,description,owner_id,context,phase,deadline,version,updated_at) VALUES (?,?,?,?,?,?,?,1,?)').run(id, input.name, input.description, actor.id, input.context, input.phase, input.deadline, nowISO());
        db.prepare('INSERT INTO memberships VALUES (?,?)').run(actor.id, id);
        const project = this.project(id);
        db.prepare('INSERT INTO project_history VALUES (?,?,?)').run(id, 1, JSON.stringify(snapshot(project, actor)));
        return project;
      });
    },
    updateContext(id, actor, input, expectedVersion) {
      return transaction(() => {
        const previous = this.project(id);
        if (previous.version !== expectedVersion) return null;
        if (!db.prepare('SELECT version FROM project_history WHERE project_id=? AND version=?').get(id, previous.version)) db.prepare('INSERT INTO project_history VALUES (?,?,?)').run(id, previous.version, JSON.stringify(snapshot(previous, actor)));
        db.prepare('UPDATE projects SET name=?,description=?,context=?,phase=?,deadline=?,version=version+1,updated_at=? WHERE id=?').run(input.name, input.description, input.context, input.phase, input.deadline, nowISO(), id);
        const project = this.project(id);
        db.prepare('INSERT INTO project_history VALUES (?,?,?)').run(id, project.version, JSON.stringify(snapshot(project, actor)));
        return project;
      });
    },
    projectContext(id) { return { project: this.project(id), members: db.prepare('SELECT users.id,users.name FROM users JOIN memberships ON users.id=memberships.user_id WHERE project_id=? ORDER BY users.name,users.id').all(id), history: db.prepare('SELECT record_json FROM project_history WHERE project_id=? ORDER BY version DESC').all(id).map(row => JSON.parse(row.record_json)) }; },
    rotateInvite(id) { const code = `join_${randomBytes(24).toString('base64url')}`; const expires_at = new Date(Date.now() + INVITE_MS).toISOString(); db.prepare('INSERT INTO project_invites VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at').run(id, digest(code), expires_at); return { invite_code: code, expires_at }; },
    joinProject(userId, code) { const invite = db.prepare('SELECT project_id FROM project_invites WHERE code_hash=? AND expires_at>?').get(digest(code), nowISO()); if (!invite) return null; db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)').run(userId, invite.project_id); return this.project(invite.project_id); },
    chargeAI(userId, userLimit, globalLimit) { return transaction(() => { const day = nowISO().slice(0, 10); const own = db.prepare('SELECT calls FROM ai_usage WHERE day=? AND user_id=?').get(day, userId)?.calls ?? 0; const total = db.prepare('SELECT COALESCE(SUM(calls),0) AS count FROM ai_usage WHERE day=?').get(day).count; if (own >= userLimit || total >= globalLimit) return false; db.prepare('INSERT INTO ai_usage VALUES (?,?,1) ON CONFLICT(day,user_id) DO UPDATE SET calls=calls+1').run(day, userId); return true; }); },
    projectUsage(id) { return db.prepare('SELECT COUNT(*) AS commits,COALESCE(SUM(length(record_json)+COALESCE(json_extract(record_json,\'$.evidence.image_bytes\'),0)),0)*3 AS bytes FROM commit_records WHERE project_id=?').get(id); },
    getCommit(id) { const row = db.prepare('SELECT * FROM commit_records WHERE id=?').get(id); return row ? { commit: JSON.parse(row.record_json), hash: row.request_hash, userId: row.user_id } : null; },
    commits(projectId, since = 0) { return db.prepare('SELECT record_json FROM commit_records WHERE project_id=? AND sequence>? ORDER BY sequence DESC').all(projectId, since).map(row => JSON.parse(row.record_json)); },
    sequence(projectId) { return db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM commit_records WHERE project_id=?').get(projectId).sequence; },
    insertCommit(commit, hash) { db.prepare('INSERT INTO commit_records VALUES (?, ?, ?, ?, ?, ?)').run(commit.id, commit.project_id, commit.sequence, JSON.stringify(commit), hash, commit.author.id); },
    updateCommit(commit) { db.prepare('UPDATE commit_records SET record_json=? WHERE id=?').run(JSON.stringify(commit), commit.id); },
    comments(id) { return db.prepare('SELECT record_json FROM comments WHERE commit_id=? ORDER BY created_at, id').all(id).map(row => JSON.parse(row.record_json)); },
    commentCount(projectId) { return db.prepare('SELECT COUNT(*) AS count FROM comments WHERE project_id=?').get(projectId).count; },
    addComment(commit, user, body) { const comment = { id: `cm_${randomUUID()}`, commit_id: commit.id, project_id: commit.project_id, body, author: user, created_at: nowISO() }; db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?)').run(comment.id, commit.id, commit.project_id, JSON.stringify(comment), comment.created_at); return comment; },
    seen(userId, projectId) { return db.prepare('SELECT sequence FROM seen WHERE user_id=? AND project_id=?').get(userId, projectId)?.sequence ?? 0; },
    markSeen(userId, projectId, sequence) { db.prepare('INSERT INTO seen VALUES (?, ?, ?) ON CONFLICT(user_id,project_id) DO UPDATE SET sequence=MAX(sequence, excluded.sequence)').run(userId, projectId, sequence); return this.seen(userId, projectId); },
    close() { db.close(); },
  };
  return api;
}
