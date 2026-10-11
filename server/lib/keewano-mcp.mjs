// Keewano documents Streamable HTTP with a personal token in k-token.
// Query tool names and arguments must come from authenticated tools/list discovery.
const endpointDefault = 'https://api.keewano.com/mcp';
const versions = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class KeewanoMcpError extends Error {
  constructor(code) {
    super(`Keewano MCP ${code}`);
    this.name = 'KeewanoMcpError';
    this.code = code;
  }
}

function fail(code) { throw new KeewanoMcpError(code); }

export function createKeewanoMcpClient({
  pat = process.env.KEEWANO_PAT,
  endpoint = endpointDefault,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maxBytes = 262144,
  readOnlyToolNames = []
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0 ||
    !Array.isArray(readOnlyToolNames) || readOnlyToolNames.some(name => typeof name !== 'string' || !name || name.length > 128)) fail('invalid_configuration');
  let sessionId;
  let protocolVersion;
  let initialized = false;
  let nextId = 0;
  let initialization;
  let tools = new Map();
  const allowed = new Set(readOnlyToolNames);
  const byteLimit = Math.min(1048576, Math.max(1024, maxBytes));
  const requestTimeout = Math.min(30000, Math.max(1, timeoutMs));

  function configured() { return typeof pat === 'string' && pat.trim().length > 0; }

  async function readReply(response, id, signal) {
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['application/json', 'text/event-stream'].includes(type)) fail('invalid_response');
    if (Number(response.headers.get('content-length')) > byteLimit) fail('response_too_large');
    const reader = response.body?.getReader();
    if (!reader) fail('invalid_response');
    const decoder = new TextDecoder();
    let bytes = 0;
    let buffer = '';
    function message(value) {
      if (!plainObject(value) || value.jsonrpc !== '2.0') fail('invalid_response');
      if (value.id !== id) {
        // This client advertises no sampling/elicitation and never executes server requests.
        if (Object.hasOwn(value, 'id') && value.method) fail('unsupported_server_request');
        return null;
      }
      if (Object.hasOwn(value, 'error')) fail('rpc_error');
      if (!plainObject(value.result)) fail('invalid_response');
      return value.result;
    }
    function event(block) {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data.trim()) return null;
      return message(JSON.parse(data));
    }
    try {
      while (true) {
        if (signal.aborted) fail('timeout');
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > byteLimit) fail('response_too_large');
        buffer += decoder.decode(value, { stream: true });
        if (type === 'text/event-stream') {
          buffer = buffer.replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const result = event(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (result !== null) return result;
          }
        }
      }
      buffer += decoder.decode();
      const result = type === 'application/json' ? message(JSON.parse(buffer)) : event(buffer);
      if (result === null) fail('invalid_response');
      return result;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function rpc(method, params, notification = false) {
    if (!configured()) fail('not_configured');
    if (pat.length > 8192 || /[\r\n]/.test(pat)) fail('invalid_configuration');
    let url;
    try { url = new URL(endpoint); } catch { fail('invalid_configuration'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) fail('invalid_configuration');
    const id = notification ? undefined : ++nextId;
    let body;
    try { body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }); }
    catch { fail('invalid_arguments'); }
    if (Buffer.byteLength(body) > byteLimit) fail('request_too_large');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new KeewanoMcpError('timeout')); }, requestTimeout);
    });
    const operation = (async () => {
      const response = await fetchImpl(url.href, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'k-token': pat,
          ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}),
          ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {})
        }, body
      });
      if ([401, 403].includes(response.status)) fail('authentication_failed');
      if (response.status === 404 && sessionId) {
        sessionId = undefined; protocolVersion = undefined; initialized = false; tools = new Map();
        fail('session_expired');
      }
      if (!response.ok) fail('transport_error');
      if (notification) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 202 && response.status !== 204) fail('invalid_response');
        return null;
      }
      const result = await readReply(response, id, controller.signal);
      if (method === 'initialize') {
        const assigned = response.headers.get('mcp-session-id');
        if (assigned !== null && (!/^[\x21-\x7e]{1,2048}$/.test(assigned))) fail('invalid_response');
        sessionId = assigned || undefined;
      }
      return result;
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof KeewanoMcpError) throw error;
      fail(controller.signal.aborted ? 'timeout' : 'invalid_response');
    } finally { clearTimeout(timer); }
  }

  async function initialize() {
    if (initialized) return { protocolVersion };
    if (initialization) return initialization;
    initialization = (async () => {
      const result = await rpc('initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cmdshift3', version: '0.2.0' }
      });
      if (!versions.has(result.protocolVersion) || !plainObject(result.capabilities) || !plainObject(result.capabilities.tools)) fail('unsupported_protocol');
      protocolVersion = result.protocolVersion;
      await rpc('notifications/initialized', undefined, true);
      initialized = true;
      return { protocolVersion, serverInfo: result.serverInfo };
    })();
    try { return await initialization; }
    catch (error) { sessionId = undefined; protocolVersion = undefined; initialized = false; throw error; }
    finally { initialization = undefined; }
  }

  async function listTools() {
    await initialize();
    const discovered = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) fail('invalid_response');
      for (const tool of result.tools) {
        if (!plainObject(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || !plainObject(tool.inputSchema) || tool.inputSchema.type !== 'object' || discovered.has(tool.name)) fail('invalid_response');
        discovered.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
        if (discovered.size > 100) fail('response_too_large');
      }
      if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === '') {
        tools = discovered;
        return [...tools.values()];
      }
      cursor = result.nextCursor;
      if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)) fail('invalid_response');
      cursors.add(cursor);
    }
    fail('response_too_large');
  }

  async function callReadOnlyTool(name, args = {}) {
    if (typeof name !== 'string' || !allowed.has(name)) fail('tool_not_allowed');
    if (!plainObject(args)) fail('invalid_arguments');
    if (!initialized || !tools.size) await listTools();
    const tool = tools.get(name);
    if (!tool) fail('tool_not_discovered');
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) fail('tool_not_read_only');
    // The caller supplies arguments reviewed against this exact discovered schema.
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError === true) fail('tool_error');
    if (!Array.isArray(result.content) && !plainObject(result.structuredContent)) fail('invalid_response');
    return { ...(Array.isArray(result.content) ? { content: result.content } : {}),
      ...(plainObject(result.structuredContent) ? { structuredContent: result.structuredContent } : {}), isError: false };
  }

  return { configured, initialize, listTools, callReadOnlyTool };
}

function sanitized(error) { return error instanceof KeewanoMcpError ? error.code : 'unavailable'; }

export async function discoverKeewanoTools(options = {}) {
  try {
    const client = createKeewanoMcpClient(options);
    if (!client.configured()) return { provider: 'keewano', status: 'disabled', tools: [] };
    return { provider: 'keewano', status: 'discovered', tools: await client.listTools() };
  }
  catch (error) { return { provider: 'keewano', status: 'unavailable', error: sanitized(error), tools: [] }; }
}

export async function queryKeewanoReadOnly({ toolName, arguments: args, ...options } = {}) {
  try {
    const client = createKeewanoMcpClient(options);
    if (!client.configured()) return { provider: 'keewano', status: 'disabled' };
    return { provider: 'keewano', status: 'completed', tool: toolName, result: await client.callReadOnlyTool(toolName, args) };
  }
  catch (error) { return { provider: 'keewano', status: 'unavailable', error: sanitized(error) }; }
}
