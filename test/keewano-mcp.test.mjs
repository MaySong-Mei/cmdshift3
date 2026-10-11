import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeewanoMcpClient, discoverKeewanoTools, queryKeewanoReadOnly } from '../server/lib/keewano-mcp.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const definition = (name = 'verified_query') => ({ name, description: 'Test-only read query', inputSchema: { type: 'object', properties: { project: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } });

function fixture(respond, options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = { url, init, message: JSON.parse(init.body) };
    requests.push(request);
    if (respond) {
      const response = await respond(request, requests.length);
      if (response) return response;
    }
    const { id, method } = request.message;
    if (method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-keewano', version: '1' } } }), { headers: { 'Content-Type': 'application/json', 'MCP-Session-Id': 'session-test-only' } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: [definition()] } });
    if (method === 'tools/call') return json({ jsonrpc: '2.0', id, result: { structuredContent: { shas: ['a'.repeat(40)] }, content: [{ type: 'text', text: 'Read query completed' }] } });
    assert.fail(`Unexpected method ${method}`);
  };
  const config = { pat: 'test-personal-token', fetchImpl, readOnlyToolNames: ['verified_query'], ...options };
  return { requests, config, client: createKeewanoMcpClient(config) };
}

test('Keewano MCP disabled helpers make no transport calls', async () => {
  const options = { pat: '', fetchImpl: () => assert.fail('Unexpected query') };
  assert.deepEqual(await discoverKeewanoTools(options), { provider: 'keewano', status: 'disabled', tools: [] });
  assert.deepEqual(await queryKeewanoReadOnly(options), { provider: 'keewano', status: 'disabled' });
});

test('Keewano MCP negotiates version/session and only calls an explicitly configured discovered tool', async () => {
  const f = fixture();
  const result = await f.client.callReadOnlyTool('verified_query', { project: 'test-project' });
  assert.equal(result.structuredContent.shas[0], 'a'.repeat(40));
  assert.deepEqual(f.requests.map(request => request.message.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(f.requests[0].init.headers['k-token'], 'test-personal-token');
  assert.equal(f.requests[0].init.headers.Accept, 'application/json, text/event-stream');
  assert.equal(f.requests[0].init.headers['MCP-Session-Id'], undefined);
  assert.deepEqual(f.requests[0].message.params.capabilities, {});
  for (const request of f.requests.slice(1)) {
    assert.equal(request.init.headers['MCP-Session-Id'], 'session-test-only');
    assert.equal(request.init.headers['MCP-Protocol-Version'], '2025-06-18');
  }
  assert.deepEqual(f.requests.at(-1).message.params, { name: 'verified_query', arguments: { project: 'test-project' } });
  assert.equal('MCP-Session-Id' in result, false);
});

test('Keewano MCP reads SSE progress and split multiline response without waiting for stream close', async () => {
  let cancelled = false;
  const f = fixture(request => {
    if (request.message.method !== 'tools/list') return;
    const response = JSON.stringify({ jsonrpc: '2.0', id: request.message.id, result: { tools: [definition()] } });
    const split = response.indexOf('"result"');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const part of [': keepalive\r\n\r', '\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n', `data: ${response.slice(0, split)}\r\ndata: ${response.slice(split)}\r\n\r\n`]) controller.enqueue(encoder.encode(part));
      },
      cancel() { cancelled = true; }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.equal((await f.client.listTools())[0].name, 'verified_query');
  assert.equal(cancelled, true);
});

test('Keewano MCP tool pagination preserves discovered schema and rejects unknown/destructive tools', async () => {
  const f = fixture(request => {
    if (request.message.method !== 'tools/list') return;
    return json({ jsonrpc: '2.0', id: request.message.id, result: request.message.params.cursor ? { tools: [definition('second_query')] } : { tools: [definition()], nextCursor: 'page2' } });
  }, { readOnlyToolNames: ['verified_query', 'absent_query'] });
  assert.equal((await f.client.listTools()).length, 2);
  assert.equal(f.requests.at(-1).message.params.cursor, 'page2');
  await assert.rejects(f.client.callReadOnlyTool('absent_query'), { code: 'tool_not_discovered' });
  await assert.rejects(f.client.callReadOnlyTool('second_query'), { code: 'tool_not_allowed' });
  const unsafe = fixture(request => request.message.method === 'tools/list' ? json({ jsonrpc: '2.0', id: request.message.id, result: { tools: [{ ...definition(), annotations: { readOnlyHint: false } }] } }) : undefined);
  await assert.rejects(unsafe.client.callReadOnlyTool('verified_query'), { code: 'tool_not_read_only' });
  assert.equal(unsafe.requests.some(request => request.message.method === 'tools/call'), false);
});

test('Keewano MCP never exposes raw HTTP/RPC/tool errors or tokens', async () => {
  for (const failure of ['http', 'rpc', 'tool']) {
    const f = fixture(request => {
      if (failure === 'http') return new Response('test-personal-token raw auth body', { status: 401 });
      if (failure === 'rpc' && request.message.method === 'initialize') return json({ jsonrpc: '2.0', id: request.message.id, error: { code: -32000, message: 'test-personal-token private error' } });
      if (failure === 'tool' && request.message.method === 'tools/call') return json({ jsonrpc: '2.0', id: request.message.id, result: { isError: true, content: [{ type: 'text', text: 'test-personal-token failed' }] } });
    });
    const result = await queryKeewanoReadOnly({ ...f.config, toolName: 'verified_query', arguments: {} });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('test-personal-token'), false);
    assert.equal(result.error, failure === 'http' ? 'authentication_failed' : failure === 'rpc' ? 'rpc_error' : 'tool_error');
  }
});

test('Keewano MCP bounds body size and timeout even when an injected transport hangs', async () => {
  const large = fixture(request => request.message.method === 'initialize' ? new Response('x'.repeat(4096), { headers: { 'Content-Type': 'application/json' } }) : undefined, { maxBytes: 1024 });
  assert.equal((await discoverKeewanoTools(large.config)).error, 'response_too_large');
  const hung = { pat: 'test-personal-token', timeoutMs: 15, fetchImpl: () => new Promise(() => {}) };
  const start = Date.now();
  assert.equal((await discoverKeewanoTools(hung)).error, 'timeout');
  assert.ok(Date.now() - start < 1000);
});

test('Keewano MCP clears expired session and requires fresh initialization/discovery on the next attempt', async () => {
  let expire = true;
  const f = fixture(request => {
    if (request.message.method === 'tools/call' && expire) { expire = false; return new Response(null, { status: 404 }); }
  });
  await assert.rejects(f.client.callReadOnlyTool('verified_query'), { code: 'session_expired' });
  assert.equal((await f.client.callReadOnlyTool('verified_query')).isError, false);
  assert.equal(f.requests.filter(request => request.message.method === 'initialize').length, 2);
  const secondInitialize = f.requests.filter(request => request.message.method === 'initialize')[1];
  assert.equal(secondInitialize.init.headers['MCP-Session-Id'], undefined);
});

test('Keewano MCP rejects incompatible negotiation and mismatched reply identity', async () => {
  const unsupported = fixture(request => request.message.method === 'initialize' ? json({ jsonrpc: '2.0', id: request.message.id, result: { protocolVersion: '1999-01-01', capabilities: { tools: {} } } }) : undefined);
  assert.equal((await discoverKeewanoTools(unsupported.config)).error, 'unsupported_protocol');
  assert.equal(unsupported.requests.length, 1);
  const mismatch = fixture(request => json({ jsonrpc: '2.0', id: request.message.id + 1, result: {} }));
  assert.equal((await discoverKeewanoTools(mismatch.config)).error, 'invalid_response');
});

test('Keewano MCP configuration cannot bypass bounds or leak values through redirects', async () => {
  for (const options of [{ timeoutMs: NaN }, { maxBytes: Infinity }, { readOnlyToolNames: 'unsafe' }, { endpoint: 'http://remote.example/mcp' }, { endpoint: 'https://example.com/mcp?k-token=test-secret' }, { pat: 'test\r\nsecret' }]) {
    const result = await discoverKeewanoTools({ pat: 'test-personal-token', fetchImpl: () => assert.fail('Unexpected invalid request'), ...options });
    assert.equal(result.error, 'invalid_configuration');
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
  }
  const f = fixture();
  await f.client.listTools();
  assert.equal(f.requests.every(request => request.init.redirect === 'error'), true);
});
