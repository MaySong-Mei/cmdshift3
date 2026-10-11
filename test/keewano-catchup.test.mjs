import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const PROJECT = 'proj_cmdshift3';
const RESEARCH = 'proj_research';
const KEEWANO_PROJECT = '11111111-2222-4333-8444-555555555555';
const BASE_SUMMARY = 'Existing confirmed Git summary.';
const QUERIED_AT = '2026-10-11T20:00:00.000Z';
// This complete PNG exercises actual evidence files and actual Git commits.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const fields = (values = {}) => Object.fromEntries(
  ['shipped', 'decision', 'why', 'blocker', 'next'].map(name => [name, values[name] ?? []]),
);
const item = (text, extra = {}) => ({ id: `it_${randomUUID()}`, text, ...extra });
const deliverable = (overrides = {}) => ({
  id: `wc_${randomUUID()}`,
  project_id: PROJECT,
  source: { app_name: 'Demo', window_title: 'Verified work', capture_kind: 'region' },
  image_base64: PNG,
  annotations: [],
  comment: 'Reviewed the work evidence.',
  summary: 'Confirmed work record',
  fields: fields(),
  ...overrides,
});
const candidate = (commit, overrides = {}) => ({
  sha: commit.git.sha,
  actor_id: commit.author.id,
  timestamp: Math.floor(Date.parse(commit.created_at) / 1000),
  blockers_recorded: commit.fields.blocker.length,
  items_resolved: commit.fields.shipped.reduce((count, entry) => count + (entry.resolves?.length ?? 0), 0),
  next_recorded: commit.fields.next.length,
  ...overrides,
});
const history = (candidates = [], status = 'completed') => ({
  provider: 'keewano', status, candidates, queried_at: QUERIED_AT,
});
const evidence = commits => commits.map(commit => ({ commit_id: commit.id, git_sha: commit.git.sha }));
const emptyActivity = { contributors: 0, blockers_recorded: 0, items_resolved: 0, next_recorded: 0 };

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cmdshift3-keewano-catchup-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const modelCalls = [];
  app = await createApp({
    dataDir,
    mode: 'demo',
    keewanoPat: 'test-only-not-real',
    keewanoProjectId: KEEWANO_PROJECT,
    organizeDeliverable: async () => { throw new Error('Unexpected draft request'); },
    summarizeProject: async input => {
      modelCalls.push({ project_id: input.project_id, since: input.since_sequence,
        through: input.through_sequence, ids: input.commits.map(commit => commit.id) });
      return { summary: BASE_SUMMARY, analyzer: { provider: 'openai', status: 'completed' } };
    },
    readKeewanoProjectHistory: async () => history([], 'not_indexed'),
    ...options,
  });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function json(method, endpoint, token, body, expected = 200) {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(value)}`);
    return value;
  }
  const may = await json('POST', '/api/session', null, { code: 'may-demo' });
  const gary = await json('POST', '/api/session', null, { code: 'gary-demo' });
  return {
    app, dataDir, may, gary, json, modelCalls,
    repo: project => path.join(dataDir, 'projects', project, 'repo'),
    submit: async (token, body) => (await json('POST', '/api/commits', token, body, 201)).commit,
    catchup: (token, project = PROJECT) => json('GET', `/api/projects/${project}/catchup`, token),
    seen: (token, through, project = PROJECT) => json('POST', `/api/projects/${project}/seen`, token, { through_sequence: through }),
  };
}

function assertUnindexed(result, recent, status) {
  assert.equal(result.summary, BASE_SUMMARY);
  assert.deepEqual(result.analyzer, { provider: 'openai', status: 'completed' });
  assert.equal(result.retrieval.provider, 'keewano');
  if (status) assert.equal(result.retrieval.status, status);
  assert.equal(result.retrieval.indexed_commits, 0);
  assert.equal(result.retrieval.recent_git_commits, recent);
  assert.deepEqual(result.retrieval.evidence, []);
  assert.deepEqual(result.retrieval.activity, emptyActivity);
}

test('Keewano verified activity supplements confirmed Git and refreshes separately from the AI cache', async t => {
  const reads = [];
  let rows = [];
  const f = await fixture(t, { readKeewanoProjectHistory: async input => {
    reads.push({ appProjectId: input.appProjectId, keewanoProjectId: input.keewanoProjectId });
    return history(structuredClone(rows));
  } });
  const blocker = item('Authentication needs review');
  const next = item('Publish the handoff');
  const first = await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [blocker], next: [next] }) }));
  const second = await f.submit(f.gary.token, deliverable({ fields: fields({
    shipped: [item('Review and handoff done', { resolves: [blocker.id, next.id] })],
    next: [item('Record the product demo')],
  }) }));
  const third = await f.submit(f.may.token, deliverable({ summary: 'Recent unindexed review' }));
  rows = [candidate(first), candidate(second), candidate(second)];
  const beforeHead = git(f.repo(PROJECT), 'rev-parse', 'HEAD');
  const beforeCount = git(f.repo(PROJECT), 'rev-list', '--count', 'HEAD');
  const result = await f.catchup(f.may.token);
  assert.deepEqual(reads, [{ appProjectId: PROJECT, keewanoProjectId: KEEWANO_PROJECT }]);
  assert.equal(result.retrieval.status, 'completed');
  assert.equal(result.retrieval.indexed_commits, 2, 'duplicate candidate SHAs must not inflate activity');
  assert.equal(result.retrieval.recent_git_commits, 1);
  assert.deepEqual(new Set(result.retrieval.evidence.map(entry => entry.git_sha)), new Set([first.git.sha, second.git.sha]));
  for (const entry of result.retrieval.evidence) assert.deepEqual(entry, evidence([first, second]).find(record => record.git_sha === entry.git_sha));
  assert.deepEqual(result.retrieval.activity, { contributors: 2, blockers_recorded: 1, items_resolved: 2, next_recorded: 2 });
  assert.equal(result.retrieval.queried_at, QUERIED_AT);
  assert.ok(result.summary.startsWith(BASE_SUMMARY));
  assert.match(result.summary, /Keewano indexed activity: 2 work commits from 2 contributors/);
  assert.match(result.summary, /1 blocker recorded/);
  assert.match(result.summary, /2 resolved-item references recorded/);
  assert.match(result.summary, /2 next steps recorded/);
  assert.match(result.summary, /1 additional Git commit is included directly from Git/);
  assert.deepEqual(result.evidence, evidence([third, second, first]));
  assert.deepEqual(result.state.blockers, [], 'recorded blocker counts must not resurrect a resolved blocker');
  assert.equal(result.state.next.length, 1);
  assert.equal(git(f.repo(PROJECT), 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(f.repo(PROJECT), 'rev-list', '--count', 'HEAD'), beforeCount);
  assert.equal(f.app.store.seen(f.may.user.id, PROJECT), 0);
  assert.equal(f.app.store.seen(f.gary.user.id, PROJECT), 0);
  assert.deepEqual(await f.catchup(f.may.token), result);
  assert.equal(reads.length, 1);
  assert.equal(f.modelCalls.length, 1);

  rows = [candidate(first), candidate(second), candidate(third)];
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock + 29_000);
  assert.equal((await f.catchup(f.may.token)).retrieval.indexed_commits, 2);
  assert.equal(reads.length, 1, 'raw retrieval remains cached within 30 seconds');
  t.mock.method(Date, 'now', () => clock + 30_001);
  const refreshed = await f.catchup(f.may.token);
  assert.equal(refreshed.retrieval.indexed_commits, 3);
  assert.equal(refreshed.retrieval.recent_git_commits, 0);
  assert.equal(reads.length, 2);
  assert.equal(f.modelCalls.length, 1, 'index refresh must reuse the unchanged base AI summary');
  assert.ok(refreshed.summary.startsWith(BASE_SUMMARY));
  assert.equal(f.app.store.seen(f.may.user.id, PROJECT), 0);
});

test('foreign SHA, actor, timestamp and each field-count mismatch never become indexed evidence', async t => {
  let rows = [];
  let reads = 0;
  const f = await fixture(t, { readKeewanoProjectHistory: async () => { reads++; return history(rows); } });
  const shared = await f.submit(f.may.token, deliverable({ fields: fields({
    blocker: [item('Review required')], next: [item('Continue after review')],
  }) }));
  const foreign = await f.submit(f.may.token, deliverable({ project_id: RESEARCH }));
  rows = [candidate(foreign),
    candidate(shared, { sha: 'f'.repeat(40) }),
    candidate(shared, { actor_id: f.gary.user.id }),
    candidate(shared, { timestamp: candidate(shared).timestamp + 1 }),
    candidate(shared, { blockers_recorded: 2 }),
    candidate(shared, { items_resolved: 1 }),
    candidate(shared, { next_recorded: 2 }),
  ];
  const result = await f.catchup(f.gary.token);
  assertUnindexed(result, 1, 'not_indexed');
  assert.deepEqual(result.evidence, evidence([shared]));
  assert.deepEqual(result.commits.map(commit => commit.id), [shared.id]);
  assert.equal(result.state.blockers[0].id, shared.fields.blocker[0].id);
  assert.equal(JSON.stringify(result).includes(foreign.git.sha), false);
  assert.equal(JSON.stringify(result).includes('f'.repeat(40)), false);
  await f.json('GET', `/api/projects/${RESEARCH}/catchup`, f.gary.token, undefined, 403);
  assert.equal(reads, 1, 'authorization is checked before sponsor retrieval');
});

test('missing sponsor configuration and empty windows make no retrieval call', async t => {
  for (const config of [{ keewanoPat: '' }, { keewanoProjectId: '' }, {}]) {
    await t.test(Object.keys(config)[0] ?? 'configured empty window', async st => {
      let reads = 0;
      const f = await fixture(st, { ...config, readKeewanoProjectHistory: async () => { reads++; return history(); } });
      const empty = await f.catchup(f.may.token);
      assert.equal(reads, 0);
      assert.equal(empty.summary, BASE_SUMMARY);
      assert.equal(empty.commits.length, 0);
      if (empty.retrieval) {
        assert.notEqual(empty.retrieval.status, 'completed');
        assertUnindexed(empty, 0, Object.keys(config).length ? 'disabled' : undefined);
      }
      if (Object.keys(config).length) {
        const commit = await f.submit(f.may.token, deliverable());
        const result = await f.catchup(f.may.token);
        assertUnindexed(result, 1, 'disabled');
        assert.deepEqual(result.evidence, evidence([commit]));
        assert.equal(reads, 0, 'both PAT and sponsor project ID are required');
      }
    });
  }
});

test('schema pending and sponsor failures retain the ordinary cached Catch-up', async t => {
  for (const status of ['schema_pending', 'unavailable']) {
    await t.test(status, async st => {
      let reads = 0;
      const f = await fixture(st, { readKeewanoProjectHistory: async () => {
        reads++;
        if (status === 'unavailable') throw new Error('Private transport detail must never reach the response');
        return history([], status);
      } });
      const commit = await f.submit(f.gary.token, deliverable({ fields: fields({ blocker: [item('Still open')] }) }));
      const result = await f.catchup(f.may.token);
      assertUnindexed(result, 1, status);
      assert.deepEqual(result.evidence, evidence([commit]));
      assert.deepEqual(result.commits.map(record => record.id), [commit.id]);
      assert.equal(result.state.blockers.length, 1);
      assert.equal(JSON.stringify(result).includes('Private transport detail'), false);
      const retry = await f.catchup(f.may.token);
      assertUnindexed(retry, 1, status);
      assert.equal(f.modelCalls.length, 1, 'sponsor failure must not invalidate the base summary cache');
      assert.ok(reads >= 1);
      assert.equal(f.app.store.seen(f.may.user.id, PROJECT), 0);
    });
  }
});

test('project retrieval coalesces across viewers while each current unseen window and authorization stays isolated', { timeout: 15000 }, async t => {
  const gate = Promise.withResolvers();
  const arrived = Promise.withResolvers();
  t.after(() => gate.resolve());
  const reads = [];
  const rows = new Map();
  const f = await fixture(t, { readKeewanoProjectHistory: async input => {
    reads.push(input.appProjectId);
    await gate.promise;
    return history(rows.get(input.appProjectId));
  } });
  const first = await f.submit(f.may.token, deliverable());
  const second = await f.submit(f.gary.token, deliverable());
  const privateCommit = await f.submit(f.may.token, deliverable({ project_id: RESEARCH }));
  rows.set(PROJECT, [candidate(first), candidate(second), candidate(privateCommit)]);
  rows.set(RESEARCH, [candidate(privateCommit), candidate(first)]);
  let requests = 0;
  const observe = req => {
    if (req.method === 'GET' && req.url === `/api/projects/${PROJECT}/catchup` && ++requests === 3) arrived.resolve();
  };
  f.app.server.on('request', observe);
  const pending = [f.catchup(f.may.token), f.catchup(f.may.token), f.catchup(f.gary.token)];
  let initial;
  try {
    await arrived.promise;
    assert.deepEqual(reads, [PROJECT], 'three same-project requests must share one reader operation');
    gate.resolve();
    initial = await Promise.all(pending);
  } finally {
    gate.resolve();
    f.app.server.off('request', observe);
    await Promise.allSettled(pending);
  }
  assert.deepEqual(initial[0], initial[1]);
  assert.equal(f.modelCalls.length, 2, 'base AI caching remains viewer-specific');
  for (const result of initial) {
    assert.equal(result.retrieval.indexed_commits, 2);
    assert.equal(result.retrieval.activity.contributors, 2);
    assert.equal(JSON.stringify(result).includes(privateCommit.git.sha), false);
  }
  await f.seen(f.gary.token, first.sequence);
  const garyUnread = await f.catchup(f.gary.token);
  assert.equal(garyUnread.since_sequence, 1);
  assert.equal(garyUnread.retrieval.indexed_commits, 1);
  assert.deepEqual(garyUnread.retrieval.evidence, evidence([second]));
  assert.equal(garyUnread.retrieval.activity.contributors, 1);
  assert.equal((await f.catchup(f.may.token)).retrieval.indexed_commits, 2);
  assert.deepEqual(reads, [PROJECT], 'seen changes refilter raw cached rows without requerying');
  const third = await f.submit(f.may.token, deliverable());
  const fresh = await f.catchup(f.may.token);
  assert.equal(fresh.retrieval.indexed_commits, 2);
  assert.equal(fresh.retrieval.recent_git_commits, 1);
  assert.deepEqual(fresh.commits.map(commit => commit.id), [third.id, second.id, first.id]);
  const privateResult = await f.catchup(f.may.token, RESEARCH);
  assert.deepEqual(reads, [PROJECT, RESEARCH], 'different app projects never share a raw retrieval cache');
  assert.equal(privateResult.retrieval.indexed_commits, 1);
  assert.deepEqual(privateResult.retrieval.evidence, evidence([privateCommit]));
  assert.equal(JSON.stringify(privateResult).includes(first.git.sha), false);
  f.app.store.db.prepare('DELETE FROM memberships WHERE user_id = ? AND project_id = ?').run(f.gary.user.id, PROJECT);
  await f.json('GET', `/api/projects/${PROJECT}/catchup`, f.gary.token, undefined, 403);
  assert.deepEqual(reads, [PROJECT, RESEARCH], 'cached retrieval never bypasses current membership');
  assert.equal(f.app.store.seen(f.may.user.id, PROJECT), 0);
});

test('model and reader waits cannot mix later Git arrivals into the original catch-up snapshot', { timeout: 15000 }, async t => {
  const modelStarted = Promise.withResolvers();
  const readerStarted = Promise.withResolvers();
  const modelGate = Promise.withResolvers();
  const readerGate = Promise.withResolvers();
  t.after(() => { modelGate.resolve(); readerGate.resolve(); });
  let rows = [];
  let reads = 0;
  const modelWindows = [];
  const f = await fixture(t, {
    summarizeProject: async input => {
      modelWindows.push({ through: input.through_sequence, ids: input.commits.map(commit => commit.id) });
      modelStarted.resolve();
      await modelGate.promise;
      return { summary: BASE_SUMMARY, analyzer: { provider: 'openai', status: 'completed' } };
    },
    readKeewanoProjectHistory: async () => {
      reads++;
      readerStarted.resolve();
      await readerGate.promise;
      return history(rows);
    },
  });
  const oldBlocker = item('Authentication prevents handoff');
  const first = await f.submit(f.may.token, deliverable({ fields: fields({ blocker: [oldBlocker] }) }));
  const pending = f.catchup(f.gary.token);
  let second;
  let snapshot;
  try {
    await Promise.all([modelStarted.promise, readerStarted.promise]);
    second = await f.submit(f.gary.token, deliverable({ fields: fields({
      shipped: [item('Authentication ready', { resolves: [oldBlocker.id] })], next: [item('Send the handoff')],
    }) }));
    rows = [candidate(first), candidate(second)];
    readerGate.resolve();
    modelGate.resolve();
    snapshot = await pending;
  } finally {
    readerGate.resolve();
    modelGate.resolve();
    await Promise.allSettled([pending]);
  }
  assert.equal(snapshot.through_sequence, 1);
  assert.deepEqual(snapshot.commits.map(commit => commit.id), [first.id]);
  assert.deepEqual(snapshot.evidence, evidence([first]));
  assert.deepEqual(snapshot.retrieval.evidence, evidence([first]));
  assert.deepEqual(snapshot.retrieval.activity, { contributors: 1, blockers_recorded: 1, items_resolved: 0, next_recorded: 0 });
  assert.equal(snapshot.state.blockers[0].id, oldBlocker.id);
  assert.equal(JSON.stringify(snapshot).includes(second.git.sha), false);
  const fresh = await f.catchup(f.gary.token);
  assert.equal(fresh.through_sequence, 2);
  assert.equal(fresh.retrieval.indexed_commits, 2);
  assert.deepEqual(fresh.retrieval.activity, { contributors: 2, blockers_recorded: 1, items_resolved: 1, next_recorded: 1 });
  assert.deepEqual(fresh.state.blockers, []);
  assert.deepEqual(modelWindows, [{ through: 1, ids: [first.id] }, { through: 2, ids: [second.id, first.id] }]);
  assert.equal(reads, 1, 'each request verifies cached candidates against its own captured Git window');
  assert.equal(f.app.store.seen(f.gary.user.id, PROJECT), 0);
  assert.equal(git(f.repo(PROJECT), 'rev-list', '--count', 'HEAD'), '2');
});
