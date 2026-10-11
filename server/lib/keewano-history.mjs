import { projectEntityUUID } from './keewano.mjs';
import { createKeewanoMcpClient, KeewanoMcpError } from './keewano-mcp.mjs';

const ownedEvents = new Map([
  ['Cmd3ActorId', 'string'], ['Cmd3CommitSha', 'string'], ['Cmd3CaptureApp', 'string'],
  ['Cmd3BlockersRecorded', 'uint'], ['Cmd3ItemsResolved', 'uint'], ['Cmd3NextRecorded', 'uint'],
  ['Cmd3WorkCommitted', 'none']
]);
const readTools = ['list_event_types', 'run_script_query'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uint = value => Number.isInteger(value) && value >= 0 && value <= 4294967295;
const safeErrors = new Set(['not_configured', 'invalid_configuration', 'timeout', 'invalid_response',
  'response_too_large', 'request_too_large', 'unsupported_server_request', 'invalid_arguments',
  'authentication_failed', 'session_expired', 'transport_error', 'rpc_error', 'unsupported_protocol',
  'tool_not_allowed', 'tool_not_discovered', 'tool_not_read_only', 'tool_error', 'invalid_result',
  'invalid_catalog', 'event_schema_mismatch', 'invalid_history']);

// Fixed source authored against Keewano's authenticated Lua guide. Names are
// resolved only after the catalog verifies all seven owned names and types.
export const projectHistoryLua = `partial = {}
partial.rows = {}
partial.scanned = 0
partial.malformed = 0
output = {}

local COMMIT = kdb.resolve_event_id("Cmd3WorkCommitted")
local SHA = kdb.resolve_event_id("Cmd3CommitSha")
local ACTOR = kdb.resolve_event_id("Cmd3ActorId")
local BLOCKERS = kdb.resolve_event_id("Cmd3BlockersRecorded")
local RESOLVED = kdb.resolve_event_id("Cmd3ItemsResolved")
local NEXT = kdb.resolve_event_id("Cmd3NextRecorded")

function process_user(user, events)
  local n = events.count
  if n == 0 then return end
  local i = events:find_prev(n - 1, COMMIT, 0)
  while i < n and partial.scanned < params.limit do
    partial.scanned = partial.scanned + 1
    local prev = events:find_prev(i - 1, COMMIT, 0)
    local start = 0
    if prev < n then start = prev + 1 end
    local sha = events:find_prev(i - 1, SHA, start)
    local actor = events:find_prev(i - 1, ACTOR, start)
    local blockers = events:find_prev(i - 1, BLOCKERS, start)
    local resolved = events:find_prev(i - 1, RESOLVED, start)
    local next_item = events:find_prev(i - 1, NEXT, start)
    if sha < n and actor < n and blockers < n and resolved < n and next_item < n then
      partial.rows[#partial.rows + 1] = {
        sha = events[sha].data,
        actor = events[actor].data,
        timestamp = events[i].timestamp,
        blockers_recorded = events[blockers].data,
        items_resolved = events[resolved].data,
        next_recorded = events[next_item].data
      }
    else
      partial.malformed = partial.malformed + 1
    end
    i = prev
  end
end

function reduce(partials)
  output.schema_version = 1
  output.entity_id = params.entity_id
  output.rows = {}
  output.scanned_records = 0
  output.malformed_records = 0
  for _, p in ipairs(partials) do
    output.scanned_records = output.scanned_records + p.scanned
    output.malformed_records = output.malformed_records + p.malformed
    for i = #p.rows, 1, -1 do
      local row = p.rows[i]
      output.rows[#output.rows + 1] = {
        sha = kdb.event_data_text(SHA, row.sha),
        actor_id = kdb.event_data_text(ACTOR, row.actor),
        timestamp = row.timestamp,
        blockers_recorded = row.blockers_recorded,
        items_resolved = row.items_resolved,
        next_recorded = row.next_recorded
      }
    end
  end
end
`;

function historyError(code) { throw new KeewanoMcpError(code); }

function toolData(result) {
  if (!isObject(result) || result.isError === true) historyError('tool_error');
  if (isObject(result.structuredContent)) return result.structuredContent;
  const text = result.content?.filter(item => item.type === 'text');
  if (!Array.isArray(text) || text.length !== 1 || typeof text[0].text !== 'string' || Buffer.byteLength(text[0].text) > 65536) historyError('invalid_result');
  try {
    const data = JSON.parse(text[0].text);
    if (!isObject(data)) historyError('invalid_result');
    return data;
  } catch { historyError('invalid_result'); }
}

function catalogState(result) {
  const data = toolData(result);
  if (!Array.isArray(data.eventTypes) || data.eventTypes.length > 1000) historyError('invalid_catalog');
  const found = new Map();
  const ids = new Set();
  for (const event of data.eventTypes) {
    if (!isObject(event) || !ownedEvents.has(event.name)) continue;
    if (!Number.isInteger(event.kdb_type_id) || event.kdb_type_id < 0 || event.kdb_type_id > 65535 || found.has(event.name) || ids.has(event.kdb_type_id) || event.data_type !== ownedEvents.get(event.name)) historyError('event_schema_mismatch');
    found.set(event.name, event.kdb_type_id);
    ids.add(event.kdb_type_id);
  }
  return [...ownedEvents.keys()].filter(name => !found.has(name));
}

function historyRows(result, entityId, limit) {
  const envelope = toolData(result);
  // Observed from the real run_script_query preflight: its script output is
  // structuredContent.result.result. Keep this exact wrapper local to history.
  const data = isObject(envelope.result) && isObject(envelope.result.result) ? envelope.result.result : envelope;
  if (data.schema_version !== 1 || data.entity_id !== entityId || !Array.isArray(data.rows) || data.rows.length > limit ||
    !uint(data.scanned_records) || data.scanned_records > limit || data.scanned_records !== data.rows.length || data.malformed_records !== 0) historyError('invalid_history');
  const seen = new Map();
  const rows = [];
  let lastTimestamp = 0;
  for (const row of data.rows) {
    if (!isObject(row) || typeof row.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(row.sha) ||
      typeof row.actor_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(row.actor_id) ||
      !uint(row.timestamp) || row.timestamp === 0 || row.timestamp < lastTimestamp ||
      !uint(row.blockers_recorded) || !uint(row.items_resolved) || !uint(row.next_recorded) ||
      (row.entity_id !== undefined && row.entity_id !== entityId)) historyError('invalid_history');
    lastTimestamp = row.timestamp;
    const candidate = { sha: row.sha.toLowerCase(), actor_id: row.actor_id, timestamp: row.timestamp,
      blockers_recorded: row.blockers_recorded, items_resolved: row.items_resolved, next_recorded: row.next_recorded };
    const previous = seen.get(candidate.sha);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(candidate)) historyError('invalid_history');
      continue;
    }
    seen.set(candidate.sha, candidate);
    rows.push(candidate);
  }
  return { rows, scanned_records: data.scanned_records };
}

// These are retrieval candidates, never verified Git evidence or computed task
// state. The application must match every SHA to its authenticated project feed.
export async function readKeewanoProjectHistory({
  appProjectId,
  keewanoProjectId,
  client,
  mcpOptions = {},
  limit = 40
} = {}) {
  const base = { provider: 'keewano', candidate_shas: [], candidates: [] };
  try {
    const reader = client || createKeewanoMcpClient({ ...mcpOptions, readOnlyToolNames: readTools });
    if (typeof reader.configured === 'function' && !reader.configured()) return { ...base, status: 'disabled' };
    if (typeof appProjectId !== 'string' || !/^proj_[A-Za-z0-9_-]{1,128}$/.test(appProjectId) ||
      typeof keewanoProjectId !== 'string' || !uuid.test(keewanoProjectId) ||
      !Number.isInteger(limit) || limit < 1 || limit > 40 || typeof reader.callReadOnlyTool !== 'function' ||
      Buffer.byteLength(projectHistoryLua) > 8192) historyError('invalid_configuration');
    const entityId = projectEntityUUID(appProjectId);
    const scope = { entity_id: entityId, limit };
    const missing = catalogState(await reader.callReadOnlyTool('list_event_types', { projectId: keewanoProjectId, nameFilter: 'Cmd3' }));
    if (missing.length) return { ...base, ...scope, status: 'schema_pending', missing_event_types: missing };
    const result = await reader.callReadOnlyTool('run_script_query', {
      projectId: keewanoProjectId,
      filters: [{ operation: 13, value: [entityId] }],
      luaScript: projectHistoryLua,
      params: { entity_id: entityId, limit }
    });
    const { rows, scanned_records } = historyRows(result, entityId, limit);
    return { provider: 'keewano', ...scope, status: rows.length ? 'completed' : 'not_indexed',
      candidate_shas: rows.map(row => row.sha), candidates: rows, scanned_records,
      queried_at: new Date().toISOString() };
  } catch (error) {
    return { ...base, status: 'unavailable', error: error instanceof KeewanoMcpError && safeErrors.has(error.code) ? error.code : 'unavailable' };
  }
}
