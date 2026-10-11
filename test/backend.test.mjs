import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';

// A complete one-pixel PNG: exercise real evidence storage, not a PNG header stub.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const PROJECT = 'proj_cmdshift3';
const RESEARCH = 'proj_research';
const fieldNames = ['shipped', 'decision', 'why', 'blocker', 'next'];
const fields = (values = {}) => Object.fromEntries(fieldNames.map((name) => [name, values[name] ?? []]));
const item = (text, extra = {}) => ({ id: `it_${randomUUID()}`, text, ...extra });
const source = { app_name: 'Demo', window_title: 'Authentication', capture_kind: 'region' };
function deliverable(overrides = {}) {
  return {
    id: `wc_${randomUUID()}`,
    project_id: PROJECT,
    source: { ...source },
    image_base64: PNG.toString('base64'),
    annotations: [{ type: 'rect', x: 0.1, y: 0.1, w: 0.4, h: 0.5, color: '#FFCC00' }],
    comment: 'Verified the authentication screen.',
    summary: 'Authentication verified',
    fields: fields(),
    ...overrides,
  };
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cmdshift3-test-'));
  const aiEnvironment = new Map(['CMD3_AI_API_KEY', 'CMD3_AI_MODEL'].map((key) => [key, process.env[key]]));
  for (const key of aiEnvironment.keys()) delete process.env[key];
  let app;
  let base;
  const start = async () => {
    app = await createApp({ dataDir, ...options });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    for (const [key, value] of aiEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const request = async (method, endpoint, token, body) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${base}${endpoint}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const json = async (method, endpoint, token, body, expected = 200) => {
    const response = await request(method, endpoint, token, body);
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(value)}`);
    return value;
  };
  const login = (code) => json('POST', '/api/session', null, { code });
  const may = await login('may-demo');
  const gary = await login('gary-demo');
  return {
    get app() { return app; },
    dataDir,
    may,
    gary,
    request,
    url: (endpoint) => `${base}${endpoint}`,
    json,
    submit: async (token, body, expected = 201) =>
      (await json('POST', '/api/commits', token, body, expected)).commit,
    restart: async (mutate) => {
      await app.close();
      if (mutate) await mutate();
      await start();
    },
    login,
  };
}

test('session author is authoritative and logout revokes the token', async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.may.user.id, f.gary.user.id);
  assert.notEqual(f.may.token, f.gary.token);
  const mayProjects = (await f.json('GET', '/api/projects', f.may.token)).projects.map((p) => p.id);
  const garyProjects = (await f.json('GET', '/api/projects', f.gary.token)).projects.map((p) => p.id);
  assert.deepEqual(new Set(mayProjects), new Set([PROJECT, RESEARCH]));
  assert.deepEqual(garyProjects, [PROJECT]);
  await f.json('GET', '/api/me', null, undefined, 401);
  await f.json('GET', '/api/me', 'not-a-real-token', undefined, 401);
  const record = await f.submit(f.gary.token, deliverable({ author: f.may.user, created_at: '1999-01-01T00:00:00Z', sequence: 500 }));
  assert.equal(record.author.id, f.gary.user.id);
  assert.equal(record.author.name, f.gary.user.name);
  assert.notEqual(record.created_at, '1999-01-01T00:00:00Z');
  assert.equal(record.sequence, 1);
  await f.json('POST', '/api/session/logout', f.gary.token, {});
  await f.json('GET', '/api/me', f.gary.token, undefined, 401);
  assert.equal((await f.json('GET', '/api/me', f.may.token)).user.id, f.may.user.id);
});

test('confirmed evidence and fields create real deliverable files and a synced Git SHA', async (t) => {
  const f = await fixture(t);
  const payload = deliverable({ fields: fields({ decision: [item('Use bearer sessions')], why: [item('Separate the two demo users')] }) });
  const record = await f.submit(f.may.token, payload);
  assert.match(record.git.sha, /^[0-9a-f]{40}$/);
  assert.equal(record.git.branch, 'main');
  assert.equal(record.git.remote_synced, true);
  assert.deepEqual(record.fields, payload.fields);
  assert.deepEqual(record.evidence.annotations, payload.annotations);
  assert.equal(record.evidence.image_url, `/api/evidence/${payload.id}`);
  assert.equal('image_base64' in record, false);
  const repo = path.join(f.dataDir, 'projects', PROJECT, 'repo');
  const origin = path.join(f.dataDir, 'projects', PROJECT, 'origin.git');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), record.git.sha);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), record.git.sha);
  const directory = `deliverables/${payload.id}`;
  const storedImage = execFileSync('git', ['-C', repo, 'show', `${record.git.sha}:${directory}/capture.png`]);
  assert.deepEqual(storedImage, PNG);
  assert.deepEqual(JSON.parse(git(repo, 'show', `${record.git.sha}:${directory}/annotations.json`)), payload.annotations);
  const manifest = JSON.parse(git(repo, 'show', `${record.git.sha}:${directory}/deliverable.json`));
  assert.equal(manifest.id, payload.id);
  assert.equal(manifest.author.id, f.may.user.id);
  assert.equal(manifest.comment, payload.comment);
  assert.deepEqual(manifest.fields, payload.fields);
  assert.equal(JSON.stringify(manifest).includes(record.git.sha), false, 'manifest must not refer to its own future Git SHA');
  assert.deepEqual(await readFile(path.join(repo, directory, 'capture.png')), PNG);
  const response = await f.request('GET', record.evidence.image_url, f.gary.token);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/png/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});

test('retries are idempotent and conflicting reuse never overwrites the Git record', async (t) => {
  const f = await fixture(t);
  const payload = deliverable();
  const original = await f.submit(f.may.token, payload);
  const retry = await f.submit(f.may.token, payload, 200);
  assert.equal(retry.git.sha, original.git.sha);
  assert.equal(retry.sequence, original.sequence);
  await f.json('POST', '/api/commits', f.may.token, { ...payload, comment: 'Changed after submission' }, 409);
  await f.json('POST', '/api/commits', f.gary.token, payload, 409);
  const feed = await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token);
  assert.equal(feed.commits.length, 1);
  assert.equal(feed.through_sequence, 1);
  assert.equal(feed.commits[0].comment, payload.comment);
  assert.equal(git(path.join(f.dataDir, 'projects', PROJECT, 'origin.git'), 'rev-parse', 'main'), original.git.sha);
});

test('failed origin pushes retain real commits and identical retries repair sync without new history', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.dataDir, 'projects', PROJECT, 'repo');
  const origin = path.join(f.dataDir, 'projects', PROJECT, 'origin.git');
  git(repo, 'remote', 'set-url', 'origin', path.join(f.dataDir, 'missing-origin.git'));
  const payload = deliverable();
  const original = await f.submit(f.may.token, payload);
  assert.equal(original.git.remote_synced, false);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), original.git.sha);
  const stillPending = await f.submit(f.may.token, payload, 200);
  assert.equal(stillPending.git.remote_synced, false);
  assert.equal(stillPending.git.sha, original.git.sha);
  git(repo, 'remote', 'set-url', 'origin', origin);
  const repaired = await f.submit(f.may.token, payload, 200);
  assert.equal(repaired.git.remote_synced, true);
  assert.equal(repaired.git.sha, original.git.sha);
  assert.equal(git(origin, 'rev-parse', 'main'), original.git.sha);
  assert.equal(git(repo, 'rev-list', '--count', 'main'), '1');
  assert.equal((await f.json('GET', `/api/commits/${original.id}`, f.gary.token)).commit.git.remote_synced, true);
});

test('concurrent contributors preserve both commits in one ordered Git history', async (t) => {
  const f = await fixture(t);
  const firstPayload = deliverable({ comment: 'May finishes the capture flow.' });
  const secondPayload = deliverable({ comment: 'Gary finishes the dashboard.' });
  const submitted = await Promise.all([
    f.submit(f.may.token, firstPayload),
    f.submit(f.gary.token, secondPayload),
  ]);
  const ordered = submitted.toSorted((a, b) => a.sequence - b.sequence);
  assert.deepEqual(ordered.map((c) => c.sequence), [1, 2]);
  assert.equal(ordered[1].git.parent_sha, ordered[0].git.sha);
  const feed = await f.json('GET', `/api/projects/${PROJECT}/commits?since_sequence=0`, f.may.token);
  assert.deepEqual(feed.commits.map((c) => c.id), ordered.toReversed().map((c) => c.id));
  assert.equal(feed.through_sequence, 2);
  const incremental = await f.json('GET', `/api/projects/${PROJECT}/commits?since_sequence=1`, f.gary.token);
  assert.deepEqual(incremental.commits.map((c) => c.id), [ordered[1].id]);
  const repo = path.join(f.dataDir, 'projects', PROJECT, 'repo');
  assert.equal(git(path.join(f.dataDir, 'projects', PROJECT, 'origin.git'), 'rev-parse', 'main'), ordered[1].git.sha);
  for (const record of submitted) {
    assert.equal(record.git.remote_synced, true);
    assert.deepEqual(await readFile(path.join(repo, 'deliverables', record.id, 'capture.png')), PNG);
    assert.equal(JSON.parse(git(repo, 'show', `${record.git.sha}:deliverables/${record.id}/deliverable.json`)).id, record.id);
  }
});

test('concurrent reuse of one commit ID across projects rejects before a second Git commit and survives restart', async (t) => {
  const f = await fixture(t);
  const payload = deliverable();
  const bodies = [payload, { ...payload, project_id: RESEARCH }];
  const results = await Promise.all(bodies.map(async (body) => {
    const response = await f.request('POST', '/api/commits', f.may.token, body);
    return { body, status: response.status, data: await response.json() };
  }));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.find((result) => result.status === 201);
  const loser = results.find((result) => result.status === 409);
  assert.equal(winner.data.commit.git.parent_sha, null, 'the first Work Commit has no Git parent');
  assert.equal(loser.data.error.code, 'idempotency_conflict');
  for (const result of results) {
    const repo = path.join(f.dataDir, 'projects', result.body.project_id, 'repo');
    if (result === winner) assert.equal(git(repo, 'rev-list', '--count', 'main'), '1');
    else assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '', 'rejected collision must never reach Git');
  }
  await f.restart();
  const fresh = await f.login('may-demo');
  const retried = await f.submit(fresh.token, winner.body, 200);
  assert.equal(retried.git.sha, winner.data.commit.git.sha);
  assert.equal(retried.git.parent_sha, null);
  await f.json('POST', '/api/commits', fresh.token, loser.body, 409);
  assert.equal((await f.json('GET', `/api/projects/${winner.body.project_id}/commits`, fresh.token)).commits.length, 1);
  assert.equal((await f.json('GET', `/api/projects/${loser.body.project_id}/commits`, fresh.token)).commits.length, 0);
});

test('missing or malformed project IDs return client errors before storage access', async (t) => {
  const f = await fixture(t);
  for (const project_id of [undefined, null, '', ' ', 42, {}, []]) {
    await f.json('POST', '/api/draft', f.may.token, { project_id, comment: 'Draft', source }, 400);
    await f.json('POST', '/api/commits', f.may.token, deliverable({ project_id }), 400);
  }
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token)).commits.length, 0);
});

test('project membership protects drafts, writes, history, evidence, discussion and events', async (t) => {
  const f = await fixture(t);
  const payload = deliverable({ project_id: RESEARCH, comment: 'Private research evidence' });
  const record = await f.submit(f.may.token, payload);
  for (const endpoint of [
    `/api/projects/${RESEARCH}/commits`,
    `/api/projects/${RESEARCH}/state`,
    `/api/projects/${RESEARCH}/catchup`,
    `/api/projects/${RESEARCH}/events`,
    `/api/commits/${record.id}`,
    `/api/commits/${record.id}/comments`,
    record.evidence.image_url,
  ]) await f.json('GET', endpoint, f.gary.token, undefined, 403);
  await f.json('POST', '/api/draft', f.gary.token, { project_id: RESEARCH, comment: 'Unauthorized', source }, 403);
  await f.json('POST', '/api/commits', f.gary.token, deliverable({ project_id: RESEARCH }), 403);
  await f.json('POST', `/api/projects/${RESEARCH}/seen`, f.gary.token, { through_sequence: 1 }, 403);
  await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token, { body: 'Unauthorized comment' }, 403);
  assert.equal((await f.json('GET', `/api/projects/${RESEARCH}/commits`, f.may.token)).commits.length, 1);
  assert.deepEqual((await f.json('GET', `/api/commits/${record.id}/comments`, f.may.token)).comments, []);
});

test('state resolves only explicitly referenced blocker and next items and keeps source history', async (t) => {
  const f = await fixture(t);
  const blocked = item('Authentication prevents handoff');
  const next = item('Complete handoff after authentication works');
  const decision = item('Use shared project history');
  const initial = await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [blocked], next: [next], decision: [decision] }) }));
  const unrelated = await f.submit(f.gary.token, deliverable({ fields: fields({ shipped: [item('Dashboard is ready')] }) }));
  let state = (await f.json('GET', `/api/projects/${PROJECT}/state`, f.gary.token)).state;
  assert.deepEqual(state.blockers.map((i) => i.id), [blocked.id]);
  assert.deepEqual(state.next.map((i) => i.id), [next.id]);
  assert.equal(state.blockers[0].git_sha, initial.git.sha);
  assert.equal(state.blockers[0].commit_id, initial.id);
  assert.equal(state.blockers[0].author.id, f.may.user.id);
  const resolved = await f.submit(f.may.token, deliverable({ fields: fields({ shipped: [item('Authentication and handoff verified', { resolves: [blocked.id, next.id] })] }) }));
  const current = await f.json('GET', `/api/projects/${PROJECT}/state`, f.may.token);
  state = current.state;
  assert.deepEqual(state.blockers, []);
  assert.deepEqual(state.next, []);
  assert.deepEqual(state.decisions.map((i) => i.id), [decision.id]);
  assert.deepEqual(new Set(state.shipped.map((i) => i.commit_id)), new Set([unrelated.id, resolved.id]));
  assert.equal(current.through_sequence, 3);
  assert.deepEqual((await f.json('GET', `/api/commits/${initial.id}`, f.gary.token)).commit.fields.blocker, [blocked]);
});

test('invalid resolution references and reused historical item IDs cannot alter project state', async (t) => {
  const f = await fixture(t);
  const blocker = item('Fix screenshot permissions');
  const decision = item('Use PNG evidence');
  await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [blocker], decision: [decision] }) }));
  const privateBlocker = item('Private research blocker');
  await f.submit(f.may.token, deliverable({ project_id: RESEARCH, fields: fields({ blocker: [privateBlocker] }) }));
  for (const reference of [item('Missing').id, decision.id, privateBlocker.id]) {
    await f.json('POST', '/api/commits', f.may.token,
      deliverable({ fields: fields({ shipped: [item('Claim resolution', { resolves: [reference] })] }) }), 409);
  }
  await f.json('POST', '/api/commits', f.may.token,
    deliverable({ fields: fields({ next: [{ id: blocker.id, text: 'Reuse an existing blocker ID' }] }) }), 409);
  const duplicate = item('Same stable ID twice');
  const duplicateResponse = await f.request('POST', '/api/commits', f.may.token,
    deliverable({ fields: fields({ blocker: [duplicate], next: [duplicate] }) }));
  assert.ok([400, 409].includes(duplicateResponse.status));
  const nonShippedResponse = await f.request('POST', '/api/commits', f.may.token,
    deliverable({ fields: fields({ decision: [item('Decisions do not close blockers', { resolves: [blocker.id] })] }) }));
  assert.ok([400, 409].includes(nonShippedResponse.status));
  const feed = await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token);
  assert.equal(feed.commits.length, 1, 'rejected work must not become a Git commit or a feed event');
  const state = (await f.json('GET', `/api/projects/${PROJECT}/state`, f.may.token)).state;
  assert.deepEqual(state.blockers.map((i) => i.id), [blocker.id]);
});

test('catch-up cursors are explicit, per-user and per-project, and preserve arrivals after a viewed sequence', async (t) => {
  const f = await fixture(t);
  const first = await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [item('Waiting for authentication')] }) }));
  const second = await f.submit(f.gary.token, deliverable({ fields: fields({ decision: [item('Share project evidence')] }) }));
  const initial = await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.gary.token);
  assert.equal(initial.since_sequence, 0);
  assert.equal(initial.through_sequence, 2);
  assert.deepEqual(new Set(initial.commits.map((c) => c.id)), new Set([first.id, second.id]));
  assert.deepEqual(new Set(initial.evidence.map((e) => e.git_sha)), new Set([first.git.sha, second.git.sha]));
  assert.equal(typeof initial.summary, 'string');
  assert.ok(initial.summary.length > 0);
  assert.equal(initial.analyzer.provider, 'manual');
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.gary.token)).since_sequence, 0, 'reading alone must not mark history as seen');
  assert.equal((await f.json('POST', `/api/projects/${PROJECT}/seen`, f.gary.token, { through_sequence: 1 })).seen_sequence, 1);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.may.token)).since_sequence, 0);
  const third = await f.submit(f.may.token, deliverable({ comment: 'Arrived while Gary read the catch-up.' }));
  assert.equal((await f.json('POST', `/api/projects/${PROJECT}/seen`, f.gary.token, { through_sequence: initial.through_sequence })).seen_sequence, 2);
  const unread = await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.gary.token);
  assert.equal(unread.since_sequence, 2);
  assert.equal(unread.through_sequence, 3);
  assert.deepEqual(unread.commits.map((c) => c.id), [third.id]);
  assert.equal((await f.json('POST', `/api/projects/${PROJECT}/seen`, f.gary.token, { through_sequence: 1 })).seen_sequence, 2, 'cursor cannot move backwards');
  await f.json('POST', `/api/projects/${PROJECT}/seen`, f.gary.token, { through_sequence: 9999 }, 400);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.gary.token)).since_sequence, 2, 'invalid future cursor must leave the unseen arrival intact');
  await f.submit(f.may.token, deliverable({ project_id: RESEARCH }));
  assert.equal((await f.json('GET', `/api/projects/${RESEARCH}/catchup`, f.may.token)).since_sequence, 0);
});

test('catch-up shares concurrent summaries and keys completed results by viewer, project and checkpoint window', { timeout: 15000 }, async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const calls = [];
  const f = await fixture(t, {
    summarizeProject: async (input) => {
      const call = calls.push(structuredClone(input));
      await gate.promise;
      return { summary: `Summary ${call}: ${input.project_id} ${input.since_sequence}-${input.through_sequence}`, analyzer: { provider: 'openai', status: 'completed' } };
    },
  });
  process.env.CMD3_AI_API_KEY = 'test-only-key';
  process.env.CMD3_AI_MODEL = 'test-only-model';
  const first = await f.submit(f.may.token, deliverable());
  const endpoint = `/api/projects/${PROJECT}/catchup`;
  const arrived = Promise.withResolvers();
  let requests = 0;
  const observe = (req) => {
    if (req.method === 'GET' && req.url === endpoint && ++requests === 2) arrived.resolve();
  };
  f.app.server.on('request', observe);
  const pending = [f.json('GET', endpoint, f.may.token), f.json('GET', endpoint, f.may.token)];
  let initial;
  try {
    await arrived.promise;
    assert.equal(calls.length, 1, 'both HTTP requests reached the route, but only one model call may start');
    gate.resolve();
    const [left, right] = await Promise.all(pending);
    assert.deepEqual(left, right);
    initial = left;
  } finally {
    gate.resolve();
    f.app.server.off('request', observe);
    await Promise.allSettled(pending);
  }
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), initial);
  const anotherMaySession = await f.login('may-demo');
  assert.equal((await f.json('GET', endpoint, anotherMaySession.token)).summary, initial.summary);
  assert.equal(calls.length, 1, 'cache belongs to the user, rather than one bearer session');

  const gary = await f.json('GET', endpoint, f.gary.token);
  assert.equal(calls.length, 2, 'another viewer must receive a separate summary');
  assert.notEqual(gary.summary, initial.summary);
  assert.deepEqual(await f.json('GET', endpoint, f.gary.token), gary);
  assert.equal(calls.length, 2);

  const second = await f.submit(f.gary.token, deliverable({ summary: 'Dashboard ready' }));
  const changed = await f.json('GET', endpoint, f.may.token);
  assert.equal(calls.length, 3, 'a new through_sequence requires new analysis');
  assert.equal(changed.through_sequence, 2);
  assert.deepEqual(changed.commits.map((commit) => commit.id), [second.id, first.id]);
  await f.json('POST', `/api/projects/${PROJECT}/seen`, f.may.token, { through_sequence: 1 });
  const afterSeen = await f.json('GET', endpoint, f.may.token);
  assert.equal(calls.length, 4, 'advancing the personal checkpoint requires a new window');
  assert.equal(afterSeen.since_sequence, 1);
  assert.equal(afterSeen.through_sequence, 2);
  assert.deepEqual(afterSeen.commits.map((commit) => commit.id), [second.id]);
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), afterSeen);
  assert.equal(calls.length, 4);

  const researchCommit = await f.submit(f.may.token, deliverable({ project_id: RESEARCH, summary: 'Private research' }));
  const research = await f.json('GET', `/api/projects/${RESEARCH}/catchup`, f.may.token);
  assert.equal(calls.length, 5, 'another project with the same 0-1 window must not reuse the first project result');
  assert.deepEqual(research.commits.map((commit) => commit.id), [researchCommit.id]);
  assert.notEqual(research.summary, initial.summary);
  assert.deepEqual(calls.map(({ project_id, since_sequence, through_sequence }) => [project_id, since_sequence, through_sequence]), [
    [PROJECT, 0, 1], [PROJECT, 0, 1], [PROJECT, 0, 2], [PROJECT, 1, 2], [RESEARCH, 0, 1],
  ]);
});

test('catch-up caches the explicit manual mode and changes cache entries when the AI provider becomes configured', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    summarizeProject: async () => {
      const configured = Boolean(process.env.CMD3_AI_API_KEY && process.env.CMD3_AI_MODEL);
      calls++;
      return { summary: `Provider summary ${calls}`, analyzer: configured ? { provider: 'openai', status: 'completed' } : { provider: 'manual', status: 'not_configured' } };
    },
  });
  await f.submit(f.may.token, deliverable());
  const endpoint = `/api/projects/${PROJECT}/catchup`;
  const manual = await f.json('GET', endpoint, f.may.token);
  assert.deepEqual(manual.analyzer, { provider: 'manual', status: 'not_configured' });
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), manual);
  assert.equal(calls, 1, 'unconfigured manual results can be reused');
  process.env.CMD3_AI_API_KEY = 'test-only-key';
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), manual);
  assert.equal(calls, 1, 'a key without a model still represents the same unconfigured provider');
  process.env.CMD3_AI_MODEL = 'test-only-model';
  const configured = await f.json('GET', endpoint, f.may.token);
  assert.deepEqual(configured.analyzer, { provider: 'openai', status: 'completed' });
  assert.notEqual(configured.summary, manual.summary);
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), configured);
  assert.equal(calls, 2, 'enabling the provider cannot return the cached manual fallback');
  delete process.env.CMD3_AI_API_KEY;
  delete process.env.CMD3_AI_MODEL;
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), manual);
  assert.equal(calls, 2);
});

test('catch-up retries an unavailable AI fallback and caches only the later completed result', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    summarizeProject: async () => {
      calls++;
      return calls === 1
        ? { summary: 'Temporary manual fallback', analyzer: { provider: 'manual', status: 'ai_unavailable' } }
        : { summary: 'Recovered AI summary', analyzer: { provider: 'openai', status: 'completed' } };
    },
  });
  process.env.CMD3_AI_API_KEY = 'test-only-key';
  process.env.CMD3_AI_MODEL = 'test-only-model';
  await f.submit(f.may.token, deliverable());
  const endpoint = `/api/projects/${PROJECT}/catchup`;
  const failed = await f.json('GET', endpoint, f.may.token);
  assert.deepEqual(failed.analyzer, { provider: 'manual', status: 'ai_unavailable' });
  const recovered = await f.json('GET', endpoint, f.may.token);
  assert.equal(calls, 2, 'the next request must retry rather than cache an unavailable fallback');
  assert.deepEqual(recovered.analyzer, { provider: 'openai', status: 'completed' });
  assert.notEqual(recovered.summary, failed.summary);
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), recovered);
  assert.equal(calls, 2, 'a completed retry becomes reusable');
});

test('cached catch-up still checks current membership and bearer session on every request', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    summarizeProject: async () => ({ summary: `Summary ${++calls}`, analyzer: { provider: 'openai', status: 'completed' } }),
  });
  await f.submit(f.may.token, deliverable());
  const endpoint = `/api/projects/${PROJECT}/catchup`;
  const may = await f.json('GET', endpoint, f.may.token);
  await f.json('GET', endpoint, f.gary.token);
  assert.equal(calls, 2);
  f.app.store.db.prepare('DELETE FROM memberships WHERE user_id = ? AND project_id = ?').run(f.gary.user.id, PROJECT);
  await f.json('GET', endpoint, f.gary.token, undefined, 403);
  assert.deepEqual(await f.json('GET', endpoint, f.may.token), may);
  await f.json('POST', '/api/session/logout', f.may.token, {});
  await f.json('GET', endpoint, f.may.token, undefined, 401);
  await f.json('GET', endpoint, null, undefined, 401);
  await f.json('GET', endpoint, 'not-a-real-token', undefined, 401);
  assert.equal(calls, 2, 'unauthorized requests must never use a cached result or invoke the model');
  const newSession = await f.login('may-demo');
  assert.deepEqual(await f.json('GET', endpoint, newSession.token), may);
  assert.equal(calls, 2, 'a fresh authorized session can reuse its user summary');
});

test('catch-up keeps its original state and evidence window while the model waits for a later commit', { timeout: 15000 }, async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const calls = [];
  const f = await fixture(t, {
    summarizeProject: async (input) => {
      calls.push(structuredClone(input));
      started.resolve();
      await gate.promise;
      return { summary: `Through ${input.through_sequence}: ${input.state.blockers.map((entry) => entry.text).join('; ')}`, analyzer: { provider: 'openai', status: 'completed' } };
    },
  });
  const oldBlocker = item('Authentication blocks handoff');
  const first = await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [oldBlocker] }) }));
  const endpoint = `/api/projects/${PROJECT}/catchup`;
  const pending = f.json('GET', endpoint, f.gary.token);
  let second;
  let newerBlocker;
  let snapshot;
  try {
    await started.promise;
    newerBlocker = item('Export needs review');
    second = await f.submit(f.may.token, deliverable({ fields: fields({
      shipped: [item('Authentication works', { resolves: [oldBlocker.id] })], blocker: [newerBlocker],
    }) }));
    gate.resolve();
    snapshot = await pending;
  } finally {
    gate.resolve();
    await Promise.allSettled([pending]);
  }
  assert.equal(snapshot.since_sequence, 0);
  assert.equal(snapshot.through_sequence, 1);
  assert.deepEqual(snapshot.commits.map((commit) => commit.id), [first.id]);
  assert.deepEqual(snapshot.evidence, [{ commit_id: first.id, git_sha: first.git.sha }]);
  assert.deepEqual(snapshot.state.blockers.map((entry) => entry.id), [oldBlocker.id]);
  assert.deepEqual(snapshot.state.shipped, []);
  assert.match(snapshot.summary, /Authentication blocks handoff/);
  assert.equal(calls[0].through_sequence, 1);
  assert.deepEqual(calls[0].commits.map((commit) => commit.id), [first.id]);
  assert.deepEqual(calls[0].state, snapshot.state);
  const current = await f.json('GET', endpoint, f.gary.token);
  assert.equal(calls.length, 2, 'the later sequence must receive its own analysis');
  assert.equal(current.through_sequence, 2);
  assert.deepEqual(current.commits.map((commit) => commit.id), [second.id, first.id]);
  assert.deepEqual(current.evidence, [
    { commit_id: second.id, git_sha: second.git.sha }, { commit_id: first.id, git_sha: first.git.sha },
  ]);
  assert.deepEqual(current.state.blockers.map((entry) => entry.id), [newerBlocker.id]);
  assert.deepEqual(current.state.shipped.map((entry) => entry.commit_id), [second.id]);
  assert.match(current.summary, /Export needs review/);
});

test('comments preserve their session author and do not rewrite immutable deliverables', async (t) => {
  const f = await fixture(t);
  const record = await f.submit(f.may.token, deliverable());
  const posted = await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token,
    { body: '<script>quoted evidence</script>', author: f.may.user, created_at: '1999-01-01T00:00:00Z' }, 201);
  assert.equal(posted.comment.author.id, f.gary.user.id);
  assert.equal(posted.comment.body, '<script>quoted evidence</script>');
  assert.notEqual(posted.comment.created_at, '1999-01-01T00:00:00Z');
  const comments = (await f.json('GET', `/api/commits/${record.id}/comments`, f.may.token)).comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, posted.comment.id);
  await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token, { body: '' }, 400);
  await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token, { body: 'x'.repeat(4001) }, 400);
  await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token, { body: 42 }, 400);
  assert.equal((await f.json('GET', `/api/commits/${record.id}`, f.may.token)).commit.git.sha, record.git.sha);
  assert.equal(git(path.join(f.dataDir, 'projects', PROJECT, 'origin.git'), 'rev-parse', 'main'), record.git.sha);
});

test('authenticated event stream announces committed work and teammate comments', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(f.url(`/api/projects/${PROJECT}/events`), {
    headers: { Authorization: `Bearer ${f.gary.token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async () => {
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = chunk.split('\n');
          const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (event) return { event, data: data ? JSON.parse(data) : null };
          continue; // SSE comments/heartbeat carry no application event.
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, 'event stream closed unexpectedly');
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  try {
    assert.equal((await nextEvent()).event, 'ready');
    const record = await f.submit(f.may.token, deliverable());
    const commitEvent = await nextEvent();
    assert.equal(commitEvent.event, 'update');
    assert.deepEqual(commitEvent.data, { type: 'commit', project_id: PROJECT, commit_id: record.id, sequence: record.sequence });
    assert.equal((await f.json('GET', `/api/commits/${record.id}`, f.gary.token)).commit.git.sha, record.git.sha);
    assert.equal(git(path.join(f.dataDir, 'projects', PROJECT, 'origin.git'), 'rev-parse', 'main'), record.git.sha);
    await f.json('POST', `/api/commits/${record.id}/comments`, f.gary.token, { body: 'Ready for handoff.' }, 201);
    const commentEvent = await nextEvent();
    assert.equal(commentEvent.event, 'update');
    assert.deepEqual(commentEvent.data, { type: 'comment', project_id: PROJECT, commit_id: record.id, sequence: record.sequence });
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('Git manifests recover a missing index record after restart without creating a duplicate commit', async (t) => {
  const f = await fixture(t);
  const payload = deliverable({ fields: fields({ blocker: [item('Recovery must retain this blocker')] }) });
  const original = await f.submit(f.may.token, payload);
  await f.restart(() => {
    const db = new DatabaseSync(path.join(f.dataDir, 'db.sqlite'));
    try {
      db.prepare('DELETE FROM commit_records WHERE id = ?').run(original.id);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commit_records WHERE id = ?').get(original.id).count, 0);
    } finally {
      db.close();
    }
  });
  const freshMay = await f.login('may-demo');
  const recovered = (await f.json('GET', `/api/commits/${original.id}`, freshMay.token)).commit;
  assert.equal(recovered.git.sha, original.git.sha);
  assert.equal(recovered.sequence, original.sequence);
  assert.deepEqual(recovered.fields, original.fields);
  const retry = await f.submit(freshMay.token, payload, 200);
  assert.equal(retry.git.sha, original.git.sha);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, freshMay.token)).commits.length, 1);
  assert.deepEqual((await f.json('GET', `/api/projects/${PROJECT}/state`, freshMay.token)).state.blockers.map((i) => i.id), payload.fields.blocker.map((i) => i.id));
  const next = await f.submit(freshMay.token, deliverable());
  assert.equal(next.sequence, original.sequence + 1);
  assert.equal(next.git.parent_sha, original.git.sha);
});

test('PNG and relative annotation validation reject malformed evidence before committing', async (t) => {
  const f = await fixture(t);
  for (const invalidImage of [Buffer.from('not an image').toString('base64'), PNG.subarray(0, 8).toString('base64'), '%%%%']) {
    await f.json('POST', '/api/commits', f.may.token, deliverable({ image_base64: invalidImage }), 400);
  }
  for (const annotations of [
    [{ type: 'rect', x: -0.1, y: 0, w: 0.2, h: 0.2, color: '#FFFFFF' }],
    [{ type: 'rect', x: 0.9, y: 0, w: 0.2, h: 0.2, color: '#FFFFFF' }],
    [{ type: 'rect', x: 0, y: 0, w: -0.2, h: 0.2, color: '#FFFFFF' }],
    [{ type: 'arrow', x: 0.1, y: 0.1, w: -0.2, h: 0.2, color: '#FFFFFF' }],
    [{ type: 'rect', x: 0, y: 0, w: 0.2, h: 0.2, color: 'red' }],
  ]) await f.json('POST', '/api/commits', f.may.token, deliverable({ annotations }), 400);
  const largeImage = Buffer.alloc(8 * 1024 * 1024 + 1);
  PNG.copy(largeImage);
  await f.json('POST', '/api/commits', f.may.token, deliverable({ image_base64: largeImage.toString('base64') }), 413);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token)).commits.length, 0);
  const valid = await f.submit(f.may.token, deliverable({
    image_base64: `data:image/png;base64,${PNG.toString('base64')}`,
    annotations: [{ type: 'arrow', x: 0.8, y: 0.8, w: -0.5, h: -0.5, color: '#FFFFFF' }],
  }));
  assert.equal(valid.sequence, 1);
});

test('incomplete PNG chunk streams, missing image data and corrupt checksums never become commits', async (t) => {
  const f = await fixture(t);
  const corruptChecksum = Buffer.from(PNG);
  corruptChecksum[52] ^= 1;
  const invalidCaptures = [
    PNG.subarray(0, 33), // Complete IHDR is insufficient: no image data or IEND.
    PNG.subarray(0, PNG.length - 1), // IEND itself is truncated.
    PNG.subarray(0, PNG.length - 12), // IDAT exists but there is no terminal IEND.
    Buffer.concat([PNG.subarray(0, 33), PNG.subarray(PNG.length - 12)]), // IHDR + IEND without IDAT.
    Buffer.concat([PNG, Buffer.from('trailing bytes')]),
    corruptChecksum,
  ];
  for (const capture of invalidCaptures) await f.json('POST', '/api/commits', f.may.token, deliverable({ image_base64: capture.toString('base64') }), 400);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token)).commits.length, 0);
  assert.equal(git(path.join(f.dataDir, 'projects', PROJECT, 'repo'), 'for-each-ref', '--format=%(refname)', 'refs/heads'), '');
  assert.equal((await f.submit(f.may.token, deliverable())).sequence, 1);
});

test('deeply nested JSON returns a client error without overflowing the idempotency hash or creating work', async (t) => {
  const f = await fixture(t);
  let nested = {};
  for (let depth = 0; depth < 70; depth++) nested = { nested };
  const response = await f.json('POST', '/api/commits', f.may.token, deliverable({ fields: nested }), 400);
  assert.match(response.error.message, /nesting/);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token)).commits.length, 0);
  assert.equal((await f.submit(f.may.token, deliverable())).sequence, 1);
});

test('draft requires membership and explicitly reports manual organization without inventing shipped work', async (t) => {
  const f = await fixture(t);
  const comment = 'Still investigating why the screenshot is blank.';
  const draft = await f.json('POST', '/api/draft', f.may.token, { project_id: PROJECT, comment, source, image_base64: PNG.toString('base64') });
  assert.equal(draft.organizer.provider, 'manual');
  assert.equal(draft.organizer.status, 'not_configured');
  assert.equal(draft.summary, comment);
  assert.deepEqual(draft.fields, fields());
  assert.ok(draft.warnings.length > 0);
  assert.equal((await f.json('GET', `/api/projects/${PROJECT}/commits`, f.may.token)).commits.length, 0, 'drafting is not committing');
});
