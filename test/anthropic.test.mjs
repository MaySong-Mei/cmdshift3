import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { organizeDeliverable, summarizeProject, answerProjectQuestion, providerStatus } from '../server/lib/ai.mjs';
import { ApiError, foldState } from '../server/lib/validation.mjs';

const keys = ['CMD3_AI_PROVIDER', 'CMD3_AI_API_KEY', 'CMD3_AI_MODEL', 'CMD3_AI_BASE_URL', 'CMD3_AI_OUTPUT_LANGUAGE', 'CMD3_AI_WORKSPACE_ID'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const names = ['shipped', 'decision', 'why', 'blocker', 'next'];
const fields = values => Object.fromEntries(names.map(name => [name, values?.[name] ?? []]));
const draft = () => ({ summary: 'Login review completed', fields: fields({ shipped: [{ text: 'Completed login review', resolves: ['it_known', 'it_unknown', 'it_known', 'it_next'] }] }), warnings: [] });
const message = output => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] });
const commit = (values = {}) => ({ id: `wc_${randomUUID()}`, sequence: 1, author: { id: 'user_may', name: 'May' }, created_at: '2026-10-11T20:00:00Z', summary: 'Reviewed login', comment: 'Confirmed review', fields: fields(), git: { sha: 'a'.repeat(40) }, ...values });

function fakeProvider(t, respond = () => message(draft()), configuration = {}) {
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const values = { CMD3_AI_PROVIDER: 'anthropic', CMD3_AI_API_KEY: 'test-only-key', CMD3_AI_MODEL: 'test-only-model', ...configuration };
  for (const key of keys) if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  t.after(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = { url: String(url), headers: options.headers, body: JSON.parse(options.body), bytes: Buffer.byteLength(options.body), signal: options.signal, redirect: options.redirect };
    requests.push(request);
    const output = await respond(request, requests.length);
    return output instanceof Response ? output : new Response(JSON.stringify(output), { status: 200 });
  });
  return requests;
}

test('Anthropic native Messages carries PNG, authenticated actor, English override and known resolve IDs', async t => {
  const requests = fakeProvider(t, undefined, { CMD3_AI_OUTPUT_LANGUAGE: 'English' });
  const input = { project_id: 'proj_test', comment: '完成了登录审阅', image_base64: PNG, actor: { id: 'user_gary', name: 'Gary', private: 'never forwarded' }, source: { app_name: 'Demo app' }, state: { blockers: [{ id: 'it_known', text: 'Login broken', author: { id: 'user_may', name: 'May' } }], next: [{ id: 'it_next', text: 'Review login' }] } };
  const original = structuredClone(input);
  const result = await organizeDeliverable(input);
  assert.deepEqual(result.organizer, { provider: 'anthropic', status: 'completed' });
  assert.deepEqual(providerStatus().ai, { provider: 'anthropic', configured: true });
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known', 'it_next']);
  assert.match(result.fields.shipped[0].id, /^it_[0-9a-f-]{36}$/);
  assert.deepEqual(input, original);
  const request = requests[0];
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-only-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.redirect, 'error');
  assert.equal(Object.keys(request.headers).some(key => key.toLowerCase() === 'authorization'), false);
  assert.equal(request.body.model, 'test-only-model');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.max_tokens, 4096);
  assert.match(request.body.system, /JSON schema/);
  assert.match(request.body.system, /"required":\["summary","fields","warnings"\]/);
  assert.match(request.body.system, /Output language override.*English/);
  assert.match(request.body.system, /use only actor.name when naming the current author/);
  assert.match(request.body.system, /screenshot alone does not verify completion/);
  assert.equal(request.body.messages.length, 1);
  assert.equal(request.body.messages[0].role, 'user');
  const payload = JSON.parse(request.body.messages[0].content[0].text);
  assert.deepEqual(payload.actor, { id: 'user_gary', name: 'Gary' });
  assert.deepEqual(payload.open_items, [...input.state.blockers, ...input.state.next]);
  assert.deepEqual(request.body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
  for (const key of ['tools', 'instructions', 'input', 'response_format']) assert.equal(Object.hasOwn(request.body, key), false);
  await organizeDeliverable({ comment: 'Reviewed again', image_base64: `data:image/png;base64,${PNG}` });
  assert.deepEqual(requests[1].body.messages[0].content[1], request.body.messages[0].content[1]);
  assert.equal(Object.hasOwn(JSON.parse(requests[1].body.messages[0].content[0].text), 'actor'), false);
});

test('Anthropic catch-up preserves attribution and questions validate citations against actual Git sources', async t => {
  const source = commit();
  const requests = fakeProvider(t, (_request, count) => message(count === 1 ? { summary: 'May reviewed login. Recording the demo remains next.' } : count === 2 ? { answer: 'Unverified claim', source_commit_ids: ['wc_fabricated'] } : { answer: 'May reviewed login.', source_commit_ids: [source.id, source.id] }), { CMD3_AI_OUTPUT_LANGUAGE: 'English', CMD3_AI_BASE_URL: 'https://model.example.test/v1/' });
  const state = { blockers: [], next: [{ id: 'it_demo', text: 'Record demo' }] };
  const summary = await summarizeProject({ project_id: 'proj_test', commits: [source], state, since_sequence: 0, through_sequence: 1 });
  assert.deepEqual(summary.analyzer, { provider: 'anthropic', status: 'completed' });
  assert.equal(requests[0].url, 'https://model.example.test/v1/messages');
  const summaryInput = JSON.parse(requests[0].body.messages[0].content[0].text);
  assert.equal(summaryInput.commits[0].git_sha, source.git.sha);
  assert.deepEqual(summaryInput.commits[0].author, source.author);
  assert.deepEqual(summaryInput.state, state);
  assert.match(requests[0].body.system, /State is authoritative/);
  let charged = 0;
  const answer = await answerProjectQuestion({ question: '谁完成了审阅？', commits: [source], beforeModelCall: () => { charged++; } });
  assert.deepEqual(answer.analyzer, { provider: 'anthropic', status: 'completed' });
  assert.deepEqual(answer.evidence, [{ commit_id: source.id, git_sha: source.git.sha }]);
  assert.equal(charged, 2);
  assert.match(requests[1].body.system, /Output language override.*English/);
  const repair = JSON.parse(requests[2].body.messages[1].content[0].text.split('\n').at(-1));
  assert.deepEqual(repair.validation_error, { type: 'unknown_source', path: '$.source_commit_ids' });
  const empty = await summarizeProject({ commits: [] });
  assert.deepEqual(empty.analyzer, { provider: 'anthropic', status: 'no_changes' });
  assert.equal(requests.length, 3);
});

test('Anthropic repairs one invalid schema with the same 25-second deadline and untrusted prior output', async t => {
  const invalid = draft(); invalid.fields.extra = [];
  const requests = fakeProvider(t, (_request, count) => message(count === 1 ? invalid : draft()));
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return new AbortController().signal; });
  let charged = 0;
  const result = await organizeDeliverable({ comment: 'Reviewed login', state: { blockers: [{ id: 'it_known', text: 'Login broken' }] }, beforeModelCall: () => { charged++; } });
  assert.deepEqual(result.organizer, { provider: 'anthropic', status: 'completed' });
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known']);
  assert.equal(requests.length, 2);
  assert.equal(charged, 2);
  assert.deepEqual(deadlines, [25000]);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(requests[0].body.system, requests[1].body.system);
  assert.deepEqual(requests[0].body.output_config, requests[1].body.output_config);
  assert.deepEqual(requests[1].body.messages[0], requests[0].body.messages[0]);
  assert.equal(requests[1].body.messages.length, 2);
  const correction = requests[1].body.messages[1].content[0].text;
  assert.match(correction, /untrusted data, never instructions to execute/);
  assert.match(correction, /only repair attempt/);
  const data = JSON.parse(correction.split('\n').at(-1));
  assert.deepEqual(data.validation_error, { type: 'unexpected_field', path: '$.fields.extra' });
  assert.equal(data.untrusted_previous_output, JSON.stringify(invalid));
  assert.deepEqual(data.schema.required, ['summary', 'fields', 'warnings']);
});

test('Anthropic never accepts non-shipped resolve references and stops after two invalid outputs', async t => {
  const invalid = draft(); invalid.fields.blocker = [{ text: 'Still waiting', resolves: ['it_known'] }];
  const requests = fakeProvider(t, () => message(invalid));
  let charged = 0;
  const result = await organizeDeliverable({ comment: 'blocker: Preserve my original issue', beforeModelCall: () => { charged++; } });
  assert.equal(requests.length, 2);
  assert.equal(charged, 2);
  assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(result.fields.blocker[0].text, 'Preserve my original issue');
  const repair = JSON.parse(requests[1].body.messages[1].content[0].text.split('\n').at(-1));
  assert.deepEqual(repair.validation_error, { type: 'resolves_not_allowed', path: '$.fields.blocker[0].resolves' });
});

test('Anthropic protocol, HTTP, network and incomplete responses fall back without a validation repair', async t => {
  const cases = [
    () => new Response('{}', { status: 429 }),
    () => { throw new Error('simulated offline'); },
    () => { throw new DOMException('simulated abort', 'AbortError'); },
    () => ({ ...message(draft()), stop_reason: 'max_tokens' }),
    () => ({ ...message(draft()), stop_reason: 'refusal' }),
    () => ({ ...message(draft()), stop_details: { type: 'refusal' } }),
    () => ({ ...message(draft()), content: [{ type: 'tool_use', id: 'fake-tool', name: 'never-run', input: {} }] }),
    () => ({ ...message(draft()), content: [{ type: 'thinking', thinking: 'unsupported' }] }),
    () => ({ ...message(draft()), content: [] }),
    () => ({ ...message(draft()), role: 'user' })
  ];
  let respond;
  const requests = fakeProvider(t, request => respond(request));
  for (const failure of cases) {
    respond = failure;
    const before = requests.length;
    let charged = 0;
    const result = await organizeDeliverable({ comment: 'next: Review manually', beforeModelCall: () => { charged++; } });
    assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
    assert.equal(result.fields.next[0].text, 'Review manually');
    assert.equal(requests.length - before, 1);
    assert.equal(charged, 1);
  }
});

test('Anthropic conversation bounds the complete request including system, schema and JSON escaping', async t => {
  const commits = Array.from({ length: 40 }, (_, index) => commit({ sequence: index + 1, summary: '审'.repeat(4000), comment: '阅'.repeat(8000), fields: fields(Object.fromEntries(names.map(name => [name, Array.from({ length: 10 }, () => ({ id: `it_${randomUUID()}`, text: '物'.repeat(4000), ...(name === 'shipped' ? { resolves: [] } : {}) }))]))) }));
  const requests = fakeProvider(t, request => {
    assert.ok(request.bytes <= 80 * 1024);
    const input = JSON.parse(request.body.messages[0].content[0].text);
    assert.ok(input.coverage.truncated);
    assert.ok(input.commits.length > 0);
    return message({ answer: 'A bounded evidence window is available.', source_commit_ids: [input.commits[0].id] });
  }, { CMD3_AI_OUTPUT_LANGUAGE: 'English' });
  let charged = 0;
  const answer = await answerProjectQuestion({ question: '问'.repeat(2000), history: Array.from({ length: 3 }, () => ({ role: 'user', content: '询'.repeat(2000) })), project: { context: '景'.repeat(12000), description: '背'.repeat(2000) }, commits, state: foldState(commits), beforeModelCall: () => { charged++; } });
  assert.equal(answer.analyzer.status, 'completed');
  assert.equal(requests.length, 1);
  assert.equal(charged, 1);
});

test('Anthropic rejects an oversized initial conversation before sending or charging a model call', async t => {
  const requests = fakeProvider(t);
  let charged = 0;
  const answer = await answerProjectQuestion({ question: 'X'.repeat(90 * 1024), commits: [commit()], beforeModelCall: () => { charged++; } });
  assert.deepEqual(answer.analyzer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(requests.length, 0);
  assert.equal(charged, 0);
  assert.equal(answer.coverage.truncated, true);
  assert.match(answer.answer, /bounded evidence window/);
});

test('Anthropic refuses an oversized repair before a second request or second quota charge', async t => {
  const commits = Array.from({ length: 24 }, (_, index) => commit({ sequence: index + 1, summary: 'S'.repeat(450), comment: 'C'.repeat(1100), fields: fields(Object.fromEntries(names.map(name => [name, Array.from({ length: 4 }, () => ({ id: `it_${randomUUID()}`, text: 'F'.repeat(150), ...(name === 'shipped' ? { resolves: [] } : {}) }))]))) }));
  const requests = fakeProvider(t, () => message({ answer: 'X'.repeat(20000), source_commit_ids: [] }));
  let charged = 0;
  const answer = await answerProjectQuestion({ question: 'What changed? '.repeat(35), history: [{ role: 'user', content: 'context'.repeat(285) }, { role: 'assistant', content: 'context'.repeat(285) }], project: { context: 'P'.repeat(4000), description: 'D'.repeat(2000) }, commits, state: foldState(commits), beforeModelCall: () => { charged++; } });
  assert.ok(requests[0].bytes > 60 * 1024 && requests[0].bytes <= 80 * 1024);
  assert.equal(requests.length, 1);
  assert.equal(charged, 1);
  assert.deepEqual(answer.analyzer, { provider: 'manual', status: 'ai_unavailable' });
  assert.ok(!answer.answer.includes('X'.repeat(100)));
  assert.ok(answer.evidence.length > 0);
});

test('Anthropic quota ApiErrors propagate on the initial and repair attempt without extra provider requests', async t => {
  const invalid = draft(); invalid.extra = 'invalid';
  const requests = fakeProvider(t, () => message(invalid));
  const quota = new ApiError(429, 'ai_quota_exceeded', 'Test-only quota limit');
  await assert.rejects(organizeDeliverable({ comment: 'Reviewed login', beforeModelCall: () => { throw quota; } }), error => error === quota);
  assert.equal(requests.length, 0);
  let attempts = 0;
  await assert.rejects(organizeDeliverable({ comment: 'Reviewed login', beforeModelCall: () => { if (++attempts === 2) throw quota; } }), error => error === quota);
  assert.equal(attempts, 2);
  assert.equal(requests.length, 1);
  await assert.rejects(summarizeProject({ commits: [commit()], beforeModelCall: () => { throw quota; } }), error => error === quota);
  await assert.rejects(answerProjectQuestion({ question: 'What changed?', commits: [commit()], beforeModelCall: () => { throw quota; } }), error => error === quota);
  assert.equal(requests.length, 1);
});

test('Anthropic workspace ID is optional, trimmed and never forwarded to other providers', async t => {
  const requests = fakeProvider(t, request => {
    if (request.url.endsWith('/chat/completions')) return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft()) } }] };
    if (request.url.endsWith('/responses')) return { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(draft()) }] }] };
    return message(draft());
  }, { CMD3_AI_WORKSPACE_ID: '  wrkspc_test_only  ' });
  const present = await organizeDeliverable({ comment: 'Reviewed login' });
  assert.equal(present.organizer.status, 'completed');
  assert.ok(!JSON.stringify(present).includes('wrkspc_test_only'));
  assert.equal(requests[0].headers['anthropic-workspace-id'], 'wrkspc_test_only');
  process.env.CMD3_AI_WORKSPACE_ID = '   ';
  await organizeDeliverable({ comment: 'Reviewed login' });
  assert.equal(Object.hasOwn(requests[1].headers, 'anthropic-workspace-id'), false);
  delete process.env.CMD3_AI_WORKSPACE_ID;
  await organizeDeliverable({ comment: 'Reviewed login' });
  assert.equal(Object.hasOwn(requests[2].headers, 'anthropic-workspace-id'), false);
  process.env.CMD3_AI_WORKSPACE_ID = 'wrkspc_test_only';
  for (const provider of ['deepseek', 'openai']) {
    process.env.CMD3_AI_PROVIDER = provider;
    const result = await organizeDeliverable({ comment: 'Reviewed login' });
    assert.deepEqual(result.organizer, { provider, status: 'completed' });
    assert.ok(!JSON.stringify(result).includes('wrkspc_test_only'));
    assert.equal(Object.hasOwn(requests.at(-1).headers, 'anthropic-workspace-id'), false);
    assert.equal(Object.hasOwn(requests.at(-1).body, 'output_config'), false);
  }
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.ok(!JSON.stringify(request.body).includes('wrkspc_test_only'));
    assert.ok(!request.url.includes('wrkspc_test_only'));
  }
});

const reasoningBlocks = [
  { type: 'thinking', thinking: 'private-reasoning-test', signature: 'signature-must-not-leak' },
  { type: 'redacted_thinking', data: 'opaque-reasoning-test' }
];
const mixedMessage = (output, blocks = reasoningBlocks) => ({ ...message(output), content: [...blocks, ...message(output).content] });
const assertNoReasoning = value => {
  const serialized = JSON.stringify(value);
  for (const marker of ['private-reasoning-test', 'signature-must-not-leak', 'opaque-reasoning-test']) assert.ok(!serialized.includes(marker));
};

test('Anthropic thinking and redacted thinking alongside final text are accepted across draft, catch-up and question', async t => {
  const source = commit();
  let output, blocks;
  const requests = fakeProvider(t, () => mixedMessage(output, blocks));
  for (const block of reasoningBlocks) {
    blocks = [block];
    output = draft();
    const organized = await organizeDeliverable({ comment: 'Reviewed login' });
    assert.deepEqual(organized.organizer, { provider: 'anthropic', status: 'completed' });
    assertNoReasoning(organized);
    output = { summary: 'May reviewed login.' };
    const summary = await summarizeProject({ commits: [source] });
    assert.deepEqual(summary.analyzer, { provider: 'anthropic', status: 'completed' });
    assert.equal(summary.summary, output.summary);
    assertNoReasoning(summary);
    output = { answer: 'May reviewed login.', source_commit_ids: [source.id] };
    const answer = await answerProjectQuestion({ question: 'What changed?', commits: [source] });
    assert.deepEqual(answer.analyzer, { provider: 'anthropic', status: 'completed' });
    assert.deepEqual(answer.evidence, [{ commit_id: source.id, git_sha: source.git.sha }]);
    assertNoReasoning(answer);
  }
  assert.equal(requests.length, 6);
  for (const request of requests) assertNoReasoning(request.body);
});

test('Anthropic mixed reasoning preserves strict text repair and unknown-citation rejection without echoing reasoning', async t => {
  const requests = fakeProvider(t, (_request, count) => mixedMessage(count === 1 ? '{invalid-json' : count === 2 ? draft() : { answer: 'Unsupported claim', source_commit_ids: ['wc_fabricated'] }));
  const organized = await organizeDeliverable({ comment: 'Reviewed login' });
  assert.deepEqual(organized.organizer, { provider: 'anthropic', status: 'completed' });
  assert.equal(requests.length, 2);
  const draftRepair = JSON.parse(requests[1].body.messages[1].content[0].text.split('\n').at(-1));
  assert.deepEqual(draftRepair.validation_error, { type: 'invalid_json', path: '$' });
  assert.equal(draftRepair.untrusted_previous_output, '{invalid-json');
  assertNoReasoning(organized);
  assertNoReasoning(requests[1].body);
  const source = commit();
  const answer = await answerProjectQuestion({ question: 'What changed?', commits: [source] });
  assert.deepEqual(answer.analyzer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(requests.length, 4);
  assert.deepEqual(answer.evidence, [{ commit_id: source.id, git_sha: source.git.sha }]);
  const citationRepair = JSON.parse(requests[3].body.messages[1].content[0].text.split('\n').at(-1));
  assert.deepEqual(citationRepair.validation_error, { type: 'unknown_source', path: '$.source_commit_ids' });
  assertNoReasoning(answer);
  assertNoReasoning(requests[3].body);
});

test('Anthropic mixed reasoning never permits tools, unknown blocks, refusal, truncation or reasoning-only output', async t => {
  const cases = [
    { ...mixedMessage(draft()), content: [...mixedMessage(draft()).content, { type: 'tool_use', name: 'never-run', input: {} }] },
    { ...mixedMessage(draft()), content: [...mixedMessage(draft()).content, { type: 'refusal', text: 'Refused' }] },
    { ...mixedMessage(draft()), content: [...mixedMessage(draft()).content, { type: 'unknown_content', data: 'unsupported' }] },
    { ...mixedMessage(draft()), stop_reason: 'max_tokens' },
    { ...mixedMessage(draft()), stop_reason: 'refusal' },
    { ...mixedMessage(draft()), stop_details: { type: 'refusal' } },
    { ...message(draft()), content: [reasoningBlocks[0]] },
    { ...message(draft()), content: [reasoningBlocks[1]] },
    { ...message(draft()), content: reasoningBlocks }
  ];
  let reply;
  const requests = fakeProvider(t, () => reply);
  for (const value of cases) {
    reply = value;
    let charged = 0;
    const before = requests.length;
    const result = await organizeDeliverable({ comment: 'next: Review manually', beforeModelCall: () => { charged++; } });
    assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
    assert.equal(result.fields.next[0].text, 'Review manually');
    assert.equal(requests.length - before, 1);
    assert.equal(charged, 1);
    assertNoReasoning(result);
  }
});

function assertStrictObjects(schema) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    for (const child of Object.values(schema.properties)) assertStrictObjects(child);
  }
  if (schema.type === 'array') assertStrictObjects(schema.items);
}

test('Anthropic supplies native strict JSON schemas for deliverable, catch-up and project question', async t => {
  const source = commit();
  const requests = fakeProvider(t, (_request, count) => message(count === 1 ? draft() : count === 2 ? { summary: 'May reviewed login.' } : { answer: 'May reviewed login.', source_commit_ids: [source.id] }));
  const organized = await organizeDeliverable({ comment: 'Reviewed login' });
  const summary = await summarizeProject({ commits: [source] });
  const answer = await answerProjectQuestion({ question: 'What changed?', commits: [source] });
  assert.equal(organized.organizer.status, 'completed');
  assert.equal(summary.analyzer.status, 'completed');
  assert.equal(answer.analyzer.status, 'completed');
  assert.equal(requests.length, 3);
  const required = [['summary', 'fields', 'warnings'], ['summary'], ['answer', 'source_commit_ids']];
  for (const [index, request] of requests.entries()) {
    assert.equal(request.body.output_config.format.type, 'json_schema');
    const schema = request.body.output_config.format.schema;
    assert.deepEqual(schema.required, required[index]);
    assertStrictObjects(schema);
    const systemSchema = request.body.system.split('including every required field and no extra fields: ').at(-1);
    assert.deepEqual(JSON.parse(systemSchema), schema);
    assert.equal(Object.hasOwn(request.body.output_config, 'effort'), false);
    assert.equal(Object.hasOwn(request.body, 'thinking'), false);
  }
  const draftFields = requests[0].body.output_config.format.schema.properties.fields;
  assert.deepEqual(draftFields.required, names);
  for (const name of names) {
    assert.deepEqual(draftFields.properties[name].items.required, ['text', 'resolves']);
    assert.equal(draftFields.properties[name].items.properties.text.type, 'string');
    assert.equal(draftFields.properties[name].items.properties.resolves.type, 'array');
  }
  assert.equal(requests[2].body.output_config.format.schema.properties.source_commit_ids.items.type, 'string');
});

test('Anthropic configures low effort and between-tools thinking only for the exact supported Sonnet model', async t => {
  const requests = fakeProvider(t);
  for (const model of ['test-only-model', 'claude-sonnet-5-5', 'test-only-other-model', 'claude-sonnet-5-5-other']) {
    process.env.CMD3_AI_MODEL = model;
    const result = await organizeDeliverable({ comment: 'Reviewed login' });
    assert.equal(result.organizer.status, 'completed');
    const body = requests.at(-1).body;
    assert.equal(body.model, model);
    assert.equal(body.output_config.format.type, 'json_schema');
    if (model === 'claude-sonnet-5-5') {
      assert.equal(body.output_config.effort, 'low');
      assert.deepEqual(body.thinking, { type: 'between_tools' });
    } else {
      assert.equal(Object.hasOwn(body.output_config, 'effort'), false);
      assert.equal(Object.hasOwn(body, 'thinking'), false);
    }
  }
  assert.equal(requests.length, 4);
});
