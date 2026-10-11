import test from 'node:test';
import assert from 'node:assert/strict';
import { readKeewanoProjectHistory, projectHistoryLua } from '../server/lib/keewano-history.mjs';
import { projectEntityUUID } from '../server/lib/keewano.mjs';
import { KeewanoMcpError } from '../server/lib/keewano-mcp.mjs';

const appProjectId = 'proj_demo';
const keewanoProjectId = 'd9717d97-51f0-4fee-970f-9df4bc8584a7';
const entityId = projectEntityUUID(appProjectId);
const names = ['Cmd3ActorId', 'Cmd3CommitSha', 'Cmd3CaptureApp', 'Cmd3BlockersRecorded', 'Cmd3ItemsResolved', 'Cmd3NextRecorded', 'Cmd3WorkCommitted'];
const catalog = () => names.map((name, index) => ({ name, kdb_type_id: 2000 + index, data_type: index < 3 ? 'string' : index < 6 ? 'uint' : 'none' }));
const row = (sha = 'a'.repeat(40), timestamp = 1791756000) => ({ sha, actor_id: 'usr_demo', timestamp, blockers_recorded: 1, items_resolved: 0, next_recorded: 1 });
const output = (rows = [row()], overrides = {}) => ({ schema_version: 1, entity_id: entityId, rows, scanned_records: rows.length, malformed_records: 0, ...overrides });
const result = structuredContent => ({ structuredContent, isError: false });

function fixture({ events = catalog(), report = output(), custom } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    async callReadOnlyTool(name, args) {
      calls.push({ name, args });
      if (custom) return custom(name, args);
      if (name === 'list_event_types') return result({ eventTypes: events });
      if (name === 'run_script_query') return result(report);
      assert.fail(`Unexpected history tool ${name}`);
    }
  };
  return { calls, run: options => readKeewanoProjectHistory({ appProjectId, keewanoProjectId, client, ...options }) };
}

test('Keewano history with no PAT is disabled and does not call catalog or query', async () => {
  const response = await readKeewanoProjectHistory({ appProjectId, keewanoProjectId, mcpOptions: { pat: '', fetchImpl: () => assert.fail('Unexpected network') } });
  assert.deepEqual(response, { provider: 'keewano', status: 'disabled', candidate_shas: [], candidates: [] });
});

test('Keewano history discovers exact catalog before a fixed scoped ordered Lua query', async () => {
  const f = fixture({ report: output([row(), { ...row('b'.repeat(40), 1791756001), actor_id: 'usr_reviewer', blockers_recorded: 0, items_resolved: 1 }]) });
  const response = await f.run();
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.candidate_shas, ['a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(response.candidates[1].items_resolved, 1);
  assert.equal(response.candidates[1].actor_id, 'usr_reviewer');
  assert.deepEqual(f.calls.map(call => call.name), ['list_event_types', 'run_script_query']);
  assert.deepEqual(f.calls[0].args, { projectId: keewanoProjectId, nameFilter: 'Cmd3' });
  const query = f.calls[1].args;
  assert.deepEqual(query.filters, [{ operation: 13, value: [entityId] }]);
  assert.deepEqual(query.params, { entity_id: entityId, limit: 40 });
  assert.equal(query.luaScript, projectHistoryLua);
  assert.ok(Buffer.byteLength(query.luaScript) < 8192);
  assert.match(query.luaScript, /find_prev\(n - 1, COMMIT, 0\)/);
  assert.match(query.luaScript, /partial\.scanned < params\.limit/);
  assert.match(query.luaScript, /if prev < n then start = prev \+ 1 end/);
  assert.match(query.luaScript, /find_prev\(i - 1, SHA, start\)/);
  assert.match(query.luaScript, /kdb\.event_data_text\(SHA, row\.sha\)/);
  assert.equal(/table\.sort|os\.|print\(/.test(query.luaScript), false);
  assert.equal('blockers' in response, false, 'numeric retrieval counts never become current task state');
});

test('Keewano empty/partial owned catalog is pending and never runs guessed names', async () => {
  for (const events of [[], [{ name: 'App Launch', kdb_type_id: 2, data_type: 'string' }], catalog().slice(0, 3)]) {
    const f = fixture({ events });
    const response = await f.run();
    assert.equal(response.status, 'schema_pending');
    assert.ok(response.missing_event_types.includes('Cmd3WorkCommitted'));
    assert.deepEqual(f.calls.map(call => call.name), ['list_event_types']);
  }
});

test('Keewano rejects conflicting catalog names/types before executing Lua', async () => {
  for (const events of [[...catalog(), catalog()[0]], catalog().map((event, i) => i === 0 ? { ...event, data_type: 'uint' } : event), catalog().map((event, i) => i === 0 ? { ...event, kdb_type_id: 2001 } : event)]) {
    const f = fixture({ events });
    assert.equal((await f.run()).error, 'event_schema_mismatch');
    assert.equal(f.calls.length, 1);
  }
});

test('Keewano known schema with no indexed project rows reports not_indexed', async () => {
  const f = fixture({ report: output([]) });
  const response = await f.run();
  assert.equal(response.status, 'not_indexed');
  assert.deepEqual(response.candidate_shas, []);
  assert.equal(f.calls.length, 2);
});

test('Keewano real preflight result.result envelope with zero rows reports not_indexed', async () => {
  const f = fixture({ report: { result: { result: output([], { users: 0 }) } } });
  const response = await f.run();
  assert.equal(response.status, 'not_indexed');
  assert.deepEqual(response.candidates, []);
  assert.deepEqual(response.candidate_shas, []);
  assert.equal(response.entity_id, entityId);
  assert.equal(response.scanned_records, 0);
});

test('Keewano deduplicates identical SHA rows but never promotes unverified foreign SHAs to evidence', async () => {
  const foreign = row('f'.repeat(40), 1791756001);
  const f = fixture({ report: output([row(), row(), foreign]) });
  const response = await f.run();
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.candidate_shas, ['a'.repeat(40), 'f'.repeat(40)]);
  assert.equal('sources' in response, false);
  assert.equal('verified' in response, false);
  assert.equal('summary' in response, false);
});

test('Keewano rejects wrong entity, malformed/unordered/count-conflicting or excessive history', async () => {
  const reports = [
    output([row()], { entity_id: projectEntityUUID('proj_other') }),
    output([{ ...row(), entity_id: projectEntityUUID('proj_other') }]),
    output([{ ...row(), sha: 'bad-sha' }]),
    output([{ ...row(), timestamp: -1 }]),
    output([{ ...row(), actor_id: 'some private text' }]),
    output([{ ...row(), items_resolved: '1' }]),
    output([row('a'.repeat(40), 1791756002), row('b'.repeat(40), 1791756001)]),
    output([row(), { ...row(), blockers_recorded: 2 }]),
    output([row()], { malformed_records: 1 }),
    output(Array.from({ length: 41 }, () => row()))
  ];
  for (const report of reports) {
    const response = await fixture({ report }).run();
    assert.equal(response.status, 'unavailable');
    assert.equal(response.error, 'invalid_history');
    assert.deepEqual(response.candidate_shas, []);
  }
});

test('Keewano script output may be raw JSON text; prose and unknown envelopes are not guessed', async () => {
  const f = fixture({ custom: name => name === 'list_event_types' ? result({ eventTypes: catalog() }) : { content: [{ type: 'text', text: JSON.stringify(output()) }] } });
  assert.equal((await f.run()).status, 'completed');
  const prose = fixture({ custom: name => name === 'list_event_types' ? result({ eventTypes: catalog() }) : { content: [{ type: 'text', text: 'Query accepted; private-value may appear here' }] } });
  const response = await prose.run();
  assert.equal(response.error, 'invalid_result');
  assert.equal(JSON.stringify(response).includes('private-value'), false);
  assert.equal((await fixture({ report: { output: output() } }).run()).error, 'invalid_history');
});

test('Keewano history validates configuration and sanitizes unknown query failures', async () => {
  for (const options of [{ limit: 41 }, { limit: 0 }, { appProjectId: 'bad-id' }, { keewanoProjectId: 'bad-uuid' }]) {
    const f = fixture();
    assert.equal((await f.run(options)).error, 'invalid_configuration');
    assert.equal(f.calls.length, 0);
  }
  const failed = fixture({ custom: () => { throw new Error('private-value in transport'); } });
  assert.deepEqual(await failed.run(), { provider: 'keewano', status: 'unavailable', error: 'unavailable', candidate_shas: [], candidates: [] });
  const unknown = fixture({ custom: () => { throw new KeewanoMcpError('private_value'); } });
  assert.equal((await unknown.run()).error, 'unavailable');
});
