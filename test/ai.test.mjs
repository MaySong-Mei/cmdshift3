import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { organizeDeliverable, summarizeProject, providerStatus } from '../server/lib/ai.mjs';

const environmentKeys = ['CMD3_AI_PROVIDER', 'CMD3_AI_API_KEY', 'CMD3_AI_MODEL', 'CMD3_AI_BASE_URL'];

function configure(t, values = {}) {
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const draftOutput = () => ({
  summary: 'Fixed login',
  fields: {
    shipped: [{ text: 'Fixed login', resolves: ['it_known', 'it_fabricated', 'it_known', 'it_next'] }],
    decision: [], why: [], blocker: [], next: []
  },
  warnings: []
});

function completion(output, finishReason = 'stop') {
  return { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) } }] };
}

function responseOutput(output, status = 'completed') {
  return { status, output: [{ content: [{ type: 'output_text', text: typeof output === 'string' ? output : JSON.stringify(output) }] }] };
}

async function providerStub(t, { provider = 'deepseek', explicitProvider = true, response = completion(draftOutput()) } = {}) {
  const requests = [];
  let reply = response;
  let status = 200;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(typeof reply === 'function' ? reply(requests.at(-1), requests.length) : reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  configure(t, {
    CMD3_AI_PROVIDER: explicitProvider ? provider : undefined,
    CMD3_AI_API_KEY: 'test-only-key',
    CMD3_AI_MODEL: provider === 'deepseek' ? 'deepseek-flash' : 'test-model',
    CMD3_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`
  });
  return { requests, respond(value, code = 200) { reply = value; status = code; } };
}

test('manual review preserves unlabeled facts and requires explicit classification', async t => {
  configure(t);
  const draft = await organizeDeliverable({ comment: 'The prototype might be done' });
  assert.equal(draft.summary, 'The prototype might be done');
  assert.deepEqual(draft.fields.shipped, []);
  assert.deepEqual(draft.organizer, { provider: 'manual', status: 'not_configured' });
  const explicit = await organizeDeliverable({ comment: '完成：菜单栏入口\nblocker: Waiting for approval\nnext: Record demo' });
  assert.equal(explicit.fields.shipped[0].text, '菜单栏入口');
  assert.deepEqual(explicit.fields.shipped[0].resolves, []);
  assert.equal(explicit.fields.blocker[0].text, 'Waiting for approval');
  assert.match(explicit.fields.next[0].id, /^it_[0-9a-f-]{36}$/);
  const summary = await summarizeProject({ commits: [{ author: { name: 'May' }, summary: 'Menu bar shipped' }], state: { blockers: [{ text: 'Waiting for approval' }], next: [] } });
  assert.match(summary.summary, /Still blocked: Waiting for approval/);
  assert.equal(summary.analyzer.provider, 'manual');
});

test('provider status defaults to OpenAI and never treats unsupported or incomplete configuration as connected', async t => {
  configure(t, { CMD3_AI_API_KEY: 'test-only-key', CMD3_AI_MODEL: 'test-model' });
  const fetchGuard = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model call'); });
  assert.deepEqual(providerStatus().ai, { provider: 'openai', configured: true });
  process.env.CMD3_AI_PROVIDER = 'deepseek';
  assert.deepEqual(providerStatus().ai, { provider: 'deepseek', configured: true });
  process.env.CMD3_AI_PROVIDER = 'unknown-provider';
  assert.deepEqual(providerStatus().ai, { provider: 'manual', configured: false });
  const draft = await organizeDeliverable({ comment: 'blocker: Still waiting' });
  assert.deepEqual(draft.organizer, { provider: 'manual', status: 'not_configured' });
  assert.equal(draft.fields.blocker[0].text, 'Still waiting');
  const summary = await summarizeProject({ commits: [{ summary: 'Work recorded' }] });
  assert.deepEqual(summary.analyzer, { provider: 'manual', status: 'not_configured' });
  assert.equal(fetchGuard.mock.callCount(), 0);
  process.env.CMD3_AI_PROVIDER = 'deepseek';
  process.env.CMD3_AI_MODEL = '   ';
  assert.deepEqual(providerStatus().ai, { provider: 'manual', configured: false });
  process.env.CMD3_AI_MODEL = 'deepseek-flash';
  delete process.env.CMD3_AI_API_KEY;
  assert.deepEqual(providerStatus().ai, { provider: 'manual', configured: false });
});

test('OpenAI Responses compatibility carries screenshot, strict schema and filters unknown resolve references', async t => {
  const stub = await providerStub(t, { provider: 'openai', explicitProvider: false, response: responseOutput(draftOutput()) });
  const result = await organizeDeliverable({ comment: 'Fixed login and next item', image_base64: 'testPNG', actor: { id: 'user_gary', name: 'Gary' }, state: { blockers: [{ id: 'it_known', text: 'Login broken' }], next: [{ id: 'it_next', text: 'Fix login' }] } });
  assert.deepEqual(result.organizer, { provider: 'openai', status: 'completed' });
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known', 'it_next']);
  assert.match(result.fields.shipped[0].id, /^it_[0-9a-f-]{36}$/);
  const request = stub.requests[0];
  assert.equal(request.path, '/v1/responses');
  assert.equal(request.auth, 'Bearer test-only-key');
  assert.equal(request.body.model, 'test-model');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.deepEqual(JSON.parse(request.body.input[0].content[0].text).actor, { id: 'user_gary', name: 'Gary' });
  assert.match(request.body.text.format.schema.properties.fields.properties.blocker.items.properties.resolves.description, /empty array/);
  assert.equal(request.body.input[0].content[1].image_url, 'data:image/png;base64,testPNG');
  assert.match(request.body.instructions, /screenshot alone does not verify completion/);
  stub.respond(responseOutput({ summary: 'May fixed login.' }));
  const summary = await summarizeProject({ commits: [{ summary: 'Fixed login' }] });
  assert.deepEqual(summary.analyzer, { provider: 'openai', status: 'completed' });
  assert.equal(stub.requests[1].body.text.format.name, 'project_catchup');
});

test('DeepSeek Flash sends text and vision content in Chat Completions JSON mode with evidence rules', async t => {
  const stub = await providerStub(t);
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds);
    return originalTimeout(milliseconds);
  });
  const input = {
    project_id: 'proj_test', comment: 'I fixed login and completed the next item.', image_base64: 'testPNG',
    actor: { id: 'user_gary', name: 'Gary', omitted_private_context: 'not forwarded' },
    source: { app: 'Xcode', window: 'Login' },
    state: { blockers: [{ id: 'it_known', text: 'Login broken', author: { id: 'user_may', name: 'May' } }], next: [{ id: 'it_next', text: 'Fix login' }] }
  };
  const original = structuredClone(input);
  const result = await organizeDeliverable(input);
  assert.deepEqual(result.organizer, { provider: 'deepseek', status: 'completed' });
  assert.deepEqual(providerStatus().ai, { provider: 'deepseek', configured: true });
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known', 'it_next']);
  assert.match(result.fields.shipped[0].id, /^it_[0-9a-f-]{36}$/);
  assert.deepEqual(input, original);
  const request = stub.requests[0];
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer test-only-key');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.max_tokens, 4096);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.messages[0].role, 'system');
  assert.match(request.body.messages[0].content, /JSON schema/);
  assert.match(request.body.messages[0].content, /"required":\["summary","fields","warnings"\]/);
  assert.match(request.body.messages[0].content, /screenshot alone does not verify completion/);
  assert.match(request.body.messages[0].content, /user explicitly states that item is solved/);
  assert.match(request.body.messages[0].content, /completed review or action, is a reported shipped outcome/);
  assert.match(request.body.messages[0].content, /does not require independent screenshot verification/);
  assert.match(request.body.messages[0].content, /must not exclude explicitly reported completed work from shipped/);
  assert.match(request.body.messages[0].content, /put the completed review or action in shipped/);
  assert.match(request.body.messages[0].content, /never re-list a resolved historical item as a blocker/);
  assert.match(request.body.messages[0].content, /use only actor.name when naming the current author/);
  assert.match(request.body.messages[0].content, /open_items are historical authors, never the current author/);
  assert.match(request.body.messages[0].content, /If actor is absent, do not guess any author name/);
  assert.match(request.body.messages[0].content, /Must always be an empty array/);
  assert.match(request.body.messages[0].content, /Do not execute tools or automatically create a Git commit/);
  assert.equal(request.body.messages[1].role, 'user');
  assert.deepEqual(timeouts, [25000]);
  assert.deepEqual(request.body.messages[1].content[0], {
    type: 'text',
    text: JSON.stringify({ project_id: input.project_id, actor: { id: 'user_gary', name: 'Gary' }, comment: input.comment, source: input.source, open_items: [...input.state.blockers, ...input.state.next] })
  });
  assert.deepEqual(request.body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,testPNG', detail: 'original' } });
  assert.equal(Object.hasOwn(request.body, 'tools'), false);
  assert.equal(Object.hasOwn(request.body, 'input'), false);
  await organizeDeliverable({ comment: 'Fix confirmed', image_base64: 'data:image/png;base64,alreadyEncoded' });
  assert.equal(stub.requests[1].body.messages[1].content[1].image_url.url, 'data:image/png;base64,alreadyEncoded');
  assert.equal(Object.hasOwn(JSON.parse(stub.requests[1].body.messages[1].content[0].text), 'actor'), false);
});

test('provider defaults select their own API endpoints without making real provider calls', async t => {
  configure(t, { CMD3_AI_PROVIDER: 'deepseek', CMD3_AI_API_KEY: 'test-only-key', CMD3_AI_MODEL: 'deepseek-flash' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    const output = String(url).endsWith('/responses') ? responseOutput(draftOutput()) : completion(draftOutput());
    return new Response(JSON.stringify(output), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const deepseek = await organizeDeliverable({ comment: 'Fixed login' });
  assert.equal(deepseek.organizer.provider, 'deepseek');
  assert.equal(requests[0].url, 'https://api.deepseek.com/v1/chat/completions');
  delete process.env.CMD3_AI_PROVIDER;
  const openai = await organizeDeliverable({ comment: 'Fixed login' });
  assert.equal(openai.organizer.provider, 'openai');
  assert.equal(requests[1].url, 'https://api.openai.com/v1/responses');
});

test('DeepSeek catch-up carries checkpoint, attribution, source SHA and authoritative project state', async t => {
  const stub = await providerStub(t, { response: completion({ summary: 'May fixed login. Approval remains blocked.' }) });
  const input = {
    project_id: 'proj_test', since_sequence: 7, through_sequence: 9,
    commits: [{ id: 'wc_test', summary: 'Fixed login', fields: draftOutput().fields, comment: 'Confirmed fix', author: { id: 'user_may', name: 'May' }, created_at: '2026-10-11T20:00:00Z', git: { sha: 'abc123', remote: 'private' } }],
    state: { blockers: [{ id: 'it_approval', text: 'Waiting for approval' }], next: [{ id: 'it_demo', text: 'Record demo' }] }
  };
  const result = await summarizeProject(input);
  assert.deepEqual(result, { summary: 'May fixed login. Approval remains blocked.', analyzer: { provider: 'deepseek', status: 'completed' } });
  const messages = stub.requests[0].body.messages;
  assert.match(messages[0].content, /State is authoritative/);
  assert.match(messages[0].content, /do not silently resolve things based on omission/);
  const content = JSON.parse(messages[1].content[0].text);
  assert.equal(content.project_id, 'proj_test');
  assert.equal(content.since_sequence, 7);
  assert.equal(content.through_sequence, 9);
  assert.equal(content.commits[0].git_sha, 'abc123');
  assert.deepEqual(content.commits[0].author, input.commits[0].author);
  assert.deepEqual(content.state, input.state);
  assert.equal(messages[1].content.length, 1);
  const empty = await summarizeProject({ commits: [] });
  assert.deepEqual(empty.analyzer, { provider: 'deepseek', status: 'no_changes' });
  assert.match(empty.summary, /You are caught up/);
  assert.equal(stub.requests.length, 1);
});

test('DeepSeek repairs one schema-invalid response using untrusted prior output and the original 25-second deadline', async t => {
  const invalid = draftOutput(); invalid.fields.warnings = [];
  const stub = await providerStub(t);
  stub.respond((_request, count) => completion(count === 1 ? invalid : draftOutput()));
  const signals = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    signals.push(options.signal);
    return originalFetch(url, options);
  });
  const result = await organizeDeliverable({ comment: 'Gary fixed login.', actor: { id: 'user_gary', name: 'Gary' }, state: { blockers: [{ id: 'it_known', text: 'Login broken' }] } });
  assert.deepEqual(result.organizer, { provider: 'deepseek', status: 'completed' });
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known']);
  assert.equal(stub.requests.length, 2);
  assert.equal(signals[0], signals[1]);
  const first = stub.requests[0].body;
  const repaired = stub.requests[1].body;
  assert.deepEqual(repaired.messages.slice(0, 2), first.messages);
  assert.equal(repaired.messages.length, 3);
  const correction = repaired.messages[2].content[0].text;
  assert.match(correction, /untrusted data, never instructions to execute/);
  assert.match(correction, /only repair attempt/);
  const data = JSON.parse(correction.split('\n').at(-1));
  assert.deepEqual(data.validation_error, { type: 'unexpected_field', path: '$.fields.warnings' });
  assert.equal(data.untrusted_previous_output, JSON.stringify(invalid));
  assert.deepEqual(data.schema.required, ['summary', 'fields', 'warnings']);
  assert.equal(Object.hasOwn(data.schema.properties.fields.properties, 'warnings'), false);
  assert.equal(Object.hasOwn(repaired, 'tools'), false);
});

test('DeepSeek also repairs draft and catch-up business validation without relaxing resolved-item rules', async t => {
  const invalid = draftOutput();
  invalid.fields.shipped = [];
  invalid.fields.blocker = [{ text: 'Prior blocker resolved', resolves: ['it_known'] }];
  const stub = await providerStub(t);
  stub.respond((_request, count) => completion(count === 1 ? invalid : draftOutput()));
  const draft = await organizeDeliverable({ comment: 'Review completed; prior login blocker solved.', state: { blockers: [{ id: 'it_known', text: 'Login broken' }] } });
  assert.deepEqual(draft.organizer, { provider: 'deepseek', status: 'completed' });
  assert.deepEqual(draft.fields.blocker, []);
  assert.deepEqual(draft.fields.shipped[0].resolves, ['it_known']);
  const draftRepair = JSON.parse(stub.requests[1].body.messages[2].content[0].text.split('\n').at(-1));
  assert.deepEqual(draftRepair.validation_error, { type: 'resolves_not_allowed', path: '$.fields.blocker[0].resolves' });
  let summaryCalls = 0;
  stub.respond(() => completion(++summaryCalls === 1 ? { summary: '' } : { summary: 'Gary reviewed the change; login blocker is resolved.' }));
  const summary = await summarizeProject({ commits: [{ summary: 'Review completed', author: { name: 'Gary' } }] });
  assert.deepEqual(summary.analyzer, { provider: 'deepseek', status: 'completed' });
  assert.equal(summary.summary, 'Gary reviewed the change; login blocker is resolved.');
  assert.equal(stub.requests.length, 4);
  const summaryRepair = JSON.parse(stub.requests[3].body.messages[2].content[0].text.split('\n').at(-1));
  assert.deepEqual(summaryRepair.validation_error, { type: 'empty_text', path: '$.summary' });
  assert.deepEqual(summaryRepair.schema.required, ['summary']);
});

test('DeepSeek stops after two invalid outputs and never retries HTTP, timeout or interrupted completions', async t => {
  const invalid = draftOutput(); invalid.fields.warnings = [];
  const stub = await providerStub(t, { response: completion(invalid) });
  const input = { comment: 'blocker: Keep the original issue', image_base64: 'originalPNG' };
  const result = await organizeDeliverable(input);
  assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(result.fields.blocker[0].text, 'Keep the original issue');
  assert.equal(stub.requests.length, 2);
  stub.respond({ error: 'test-only-key' }, 503);
  await organizeDeliverable(input);
  assert.equal(stub.requests.length, 3);
  stub.respond(completion(draftOutput(), 'length'));
  await organizeDeliverable(input);
  assert.equal(stub.requests.length, 4);
  let timeoutCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    timeoutCalls++;
    throw new DOMException('Test timeout', 'TimeoutError');
  });
  const timedOut = await organizeDeliverable(input);
  assert.equal(timeoutCalls, 1);
  assert.deepEqual(timedOut.organizer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(timedOut.fields.blocker[0].text, 'Keep the original issue');
});

test('DeepSeek empty, invalid, truncated or interrupted completions retain the draft input and fall back', async t => {
  const stub = await providerStub(t);
  const invalid = [
    [completion(''), 2], [completion('   '), 2], [completion('{"summary":'), 2], [completion('null'), 2],
    [completion(draftOutput(), 'length'), 1], [completion(draftOutput(), 'content_filter'), 1], [completion(draftOutput(), 'tool_calls'), 1],
    [{ choices: [] }, 1], [{ choices: [{ finish_reason: 'stop', message: { content: null } }] }, 1],
    [{ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draftOutput()), tool_calls: [{ id: 'call_1' }] } }] }, 1],
    [completion('x'.repeat(40001)), 1]
  ];
  const input = { comment: 'blocker: Still waiting', image_base64: 'originalPNG', source: { app: 'Notes' } };
  const original = structuredClone(input);
  for (const [reply, expectedCalls] of invalid) {
    const previousCalls = stub.requests.length;
    stub.respond(reply);
    const result = await organizeDeliverable(input);
    assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
    assert.equal(result.fields.blocker[0].text, 'Still waiting');
    assert.deepEqual(result.fields.shipped, []);
    assert.deepEqual(input, original);
    assert.equal(stub.requests.length - previousCalls, expectedCalls);
  }
});

test('JSON syntax alone is insufficient: incomplete, wrong-type, empty or oversized draft fields fall back', async t => {
  const stub = await providerStub(t);
  const invalid = [
    { ...draftOutput(), summary: '' }, { ...draftOutput(), summary: '   ' }, { ...draftOutput(), summary: 'x'.repeat(301) },
    { ...draftOutput(), warnings: undefined }, { ...draftOutput(), warnings: [7] }, { ...draftOutput(), warnings: Array(6).fill('Review') },
    { ...draftOutput(), fields: { shipped: [] } }, { ...draftOutput(), fields: [] }, { ...draftOutput(), extra: 'unexpected' }, { ...draftOutput(), '': 'unexpected' }
  ];
  for (const item of [null, { text: 'Fixed' }, { text: 'Fixed', resolves: 'it_known' }, { text: 'Fixed', resolves: [7] }, { text: '   ', resolves: [] }, { text: 'x'.repeat(2001), resolves: [] }]) {
    const output = draftOutput(); output.fields.shipped = [item]; invalid.push(output);
  }
  const manyItems = draftOutput(); manyItems.fields.next = Array.from({ length: 31 }, () => ({ text: 'Next step', resolves: [] })); invalid.push(manyItems);
  for (const name of ['decision', 'why', 'blocker', 'next']) {
    const nonShippedResolves = draftOutput(); nonShippedResolves.fields[name] = [{ text: 'Prior blocker resolved', resolves: ['it_known'] }]; invalid.push(nonShippedResolves);
  }
  for (const output of invalid) {
    const previousCalls = stub.requests.length;
    stub.respond(completion(output));
    const result = await organizeDeliverable({ comment: 'next: Preserve this step' });
    assert.deepEqual(result.organizer, { provider: 'manual', status: 'ai_unavailable' });
    assert.equal(result.fields.next[0].text, 'Preserve this step');
    assert.deepEqual(result.fields.shipped, []);
    assert.equal(stub.requests.length - previousCalls, 2);
  }
});

test('invalid DeepSeek catch-up output retains factual work and current blockers', async t => {
  const stub = await providerStub(t);
  for (const reply of [completion(''), completion('{'), completion({}), completion({ summary: '' }), completion({ summary: 4 }), completion({ summary: 'x'.repeat(12001) }), completion({ summary: 'Valid', extra: true }), completion({ summary: 'Truncated' }, 'length')]) {
    const previousCalls = stub.requests.length;
    stub.respond(reply);
    const result = await summarizeProject({ commits: [{ author: { name: 'May' }, summary: 'Fixed login' }], state: { blockers: [{ text: 'Waiting for approval' }] } });
    assert.deepEqual(result.analyzer, { provider: 'manual', status: 'ai_unavailable' });
    assert.match(result.summary, /May: Fixed login/);
    assert.match(result.summary, /Still blocked: Waiting for approval/);
    assert.equal(stub.requests.length - previousCalls, reply.choices[0].finish_reason === 'stop' ? 2 : 1);
  }
});

test('HTTP errors never expose provider secrets or response bodies and preserve manual draft and catch-up', async t => {
  const stub = await providerStub(t);
  stub.respond({ error: 'test-only-key private provider failure' }, 503);
  const draft = await organizeDeliverable({ comment: 'blocker: Still waiting', image_base64: 'originalPNG' });
  assert.deepEqual(draft.organizer, { provider: 'manual', status: 'ai_unavailable' });
  assert.equal(draft.fields.blocker[0].text, 'Still waiting');
  assert.equal(JSON.stringify(draft).includes('test-only-key'), false);
  assert.equal(JSON.stringify(draft).includes('private provider failure'), false);
  assert.equal(stub.requests.length, 1);
  const summary = await summarizeProject({ commits: [{ summary: 'Original work retained' }] });
  assert.deepEqual(summary.analyzer, { provider: 'manual', status: 'ai_unavailable' });
  assert.match(summary.summary, /Original work retained/);
  assert.equal(JSON.stringify(summary).includes('test-only-key'), false);
  assert.equal(stub.requests.length, 2);
});

test('OpenAI malformed and incomplete responses use the same safe manual fallback', async t => {
  const stub = await providerStub(t, { provider: 'openai' });
  for (const reply of [responseOutput(draftOutput(), 'incomplete'), responseOutput(''), responseOutput('{'), responseOutput({ ...draftOutput(), summary: '' }), responseOutput({ ...draftOutput(), warnings: null })]) {
    stub.respond(reply);
    const draft = await organizeDeliverable({ comment: 'blocker: Still waiting' });
    assert.deepEqual(draft.organizer, { provider: 'manual', status: 'ai_unavailable' });
    assert.equal(draft.fields.blocker[0].text, 'Still waiting');
  }
  const empty = await summarizeProject({ commits: [] });
  assert.deepEqual(empty.analyzer, { provider: 'openai', status: 'no_changes' });
  assert.equal(stub.requests.length, 5);
  stub.respond({ error: 'test-only-key' }, 503);
  const draft = await organizeDeliverable({ comment: 'next: Retry manually' });
  assert.equal(draft.organizer.status, 'ai_unavailable');
  assert.equal(draft.fields.next[0].text, 'Retry manually');
  assert.equal(JSON.stringify(draft).includes('test-only-key'), false);
});
