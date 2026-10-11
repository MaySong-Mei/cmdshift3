import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const PROJECTS = [
  { id: 'proj_cmdshift3', name: 'CmdShift3', description: 'Commit your work. Everyone stays caught up.' },
  { id: 'proj_research', name: 'Research Lab', description: 'Private research workspace · May only' },
];
const USERS = [{ id: 'usr_may', name: 'May', code: 'may-demo' }, { id: 'usr_gary', name: 'Gary', code: 'gary-demo' }];
const digest = value => createHash('sha256').update(value).digest('hex');

export async function openStore(dataDir) {
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
  `);
  for (const user of USERS) db.prepare('INSERT OR IGNORE INTO users VALUES (?, ?)').run(user.id, user.name);
  for (const project of PROJECTS) db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(project.id, project.name, project.description);
  for (const [user, project] of [['usr_may', 'proj_cmdshift3'], ['usr_gary', 'proj_cmdshift3'], ['usr_may', 'proj_research']]) db.prepare('INSERT OR IGNORE INTO memberships VALUES (?, ?)').run(user, project);

  return {
    db,
    createSession(code) {
      const user = USERS.find(item => item.code === code);
      if (!user) return null;
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, new Date().toISOString());
      return { token, user: { id: user.id, name: user.name }, projects: this.projectsFor(user.id) };
    },
    userForToken(token) { return db.prepare('SELECT users.id, users.name FROM sessions JOIN users ON sessions.user_id=users.id WHERE token_hash=?').get(digest(token)); },
    revoke(token) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); },
    projectsFor(userId) { return db.prepare('SELECT projects.* FROM projects JOIN memberships ON memberships.project_id=projects.id WHERE memberships.user_id=? ORDER BY projects.id').all(userId); },
    hasProject(projectId) { return Boolean(db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)); },
    isMember(userId, projectId) { return Boolean(db.prepare('SELECT user_id FROM memberships WHERE user_id=? AND project_id=?').get(userId, projectId)); },
    getCommit(id) { const row = db.prepare('SELECT * FROM commit_records WHERE id=?').get(id); return row ? { commit: JSON.parse(row.record_json), hash: row.request_hash, userId: row.user_id } : null; },
    commits(projectId, since = 0) { return db.prepare('SELECT record_json FROM commit_records WHERE project_id=? AND sequence>? ORDER BY sequence DESC').all(projectId, since).map(row => JSON.parse(row.record_json)); },
    sequence(projectId) { return db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM commit_records WHERE project_id=?').get(projectId).sequence; },
    insertCommit(commit, hash) { db.prepare('INSERT INTO commit_records VALUES (?, ?, ?, ?, ?, ?)').run(commit.id, commit.project_id, commit.sequence, JSON.stringify(commit), hash, commit.author.id); },
    updateCommit(commit) { db.prepare('UPDATE commit_records SET record_json=? WHERE id=?').run(JSON.stringify(commit), commit.id); },
    comments(id) { return db.prepare('SELECT record_json FROM comments WHERE commit_id=? ORDER BY created_at, id').all(id).map(row => JSON.parse(row.record_json)); },
    addComment(commit, user, body) {
      const comment = { id: `cm_${randomUUID()}`, commit_id: commit.id, project_id: commit.project_id, body, author: user, created_at: new Date().toISOString() };
      db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?)').run(comment.id, commit.id, commit.project_id, JSON.stringify(comment), comment.created_at);
      return comment;
    },
    seen(userId, projectId) { return db.prepare('SELECT sequence FROM seen WHERE user_id=? AND project_id=?').get(userId, projectId)?.sequence ?? 0; },
    markSeen(userId, projectId, sequence) { db.prepare('INSERT INTO seen VALUES (?, ?, ?) ON CONFLICT(user_id,project_id) DO UPDATE SET sequence=MAX(sequence, excluded.sequence)').run(userId, projectId, sequence); return this.seen(userId, projectId); },
    close() { db.close(); },
  };
}
