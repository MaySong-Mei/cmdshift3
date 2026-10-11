import { createHash } from 'node:crypto';

// Optional event ingress only. Query-driven summaries are a separate, unverified integration.
const types = [
  ['Cmd3ActorId', 'string'], ['Cmd3CommitSha', 'string'], ['Cmd3CaptureApp', 'string'],
  ['Cmd3BlockersRecorded', 'uint'], ['Cmd3ItemsResolved', 'uint'], ['Cmd3NextRecorded', 'uint'], ['Cmd3WorkCommitted', 'none']
].map(([name, dataType], index) => ({ eventTypeId: 2000 + index, name, dataType }));
const customEventsHash = createHash('sha256').update(JSON.stringify(types)).digest().readUInt32BE(0) || 1;
let registeredKey;
let queue = Promise.resolve();

function projectUUID(projectId) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`cmdshift3:project:${projectId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function ingest(commit) {
  const key = process.env.KEEWANO_API_KEY;
  if (!key) return { status: 'disabled' };
  const base = process.env.CMD3_KEEWANO_BASE_URL || 'https://api.keewano.com/event/ingress/v1/json';
  const url = new URL(base);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return { status: 'unavailable' };
  async function post(path, body) {
    const result = await fetch(`${base.replace(/\/$/, '')}/${path}`, {
      method: 'POST', headers: { 'k-token': key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000), body: JSON.stringify(body)
    });
    if (!result.ok) throw new Error('ingress_unavailable');
  }
  if (registeredKey !== key) {
    await post('custom', { customEventsHash, eventTypes: types });
    registeredKey = key;
  }
  const values = [commit.author.id, commit.git.sha, commit.source.app_name.slice(0, 256),
    commit.fields.blocker.length, commit.fields.shipped.reduce((n, item) => n + (item.resolves?.length || 0), 0), commit.fields.next.length];
  const timestamp = Math.floor(new Date(commit.created_at).getTime() / 1000);
  await post('in', {
    dataSessionId: commit.id.replace(/^wc_/, ''), batch: 1, customEventsHash,
    installId: projectUUID(commit.project_id),
    events: types.map((type, index) => ({ eventTypeId: type.eventTypeId, dataType: type.dataType, timestamp, ...(index < values.length ? { data: values[index] } : {}) }))
  });
  return { status: 'accepted' };
}

export function queueCommittedEvent(commit) {
  if (!process.env.KEEWANO_API_KEY) return Promise.resolve({ status: 'disabled' });
  queue = queue.then(() => ingest(commit)).catch(() => ({ status: 'unavailable' }));
  return queue;
}
