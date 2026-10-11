import { createHash } from 'node:crypto';

// Optional typed event ingress. Acknowledgement is separate from query visibility.
const types = [
  ['Cmd3ActorId', 'string'], ['Cmd3CommitSha', 'string'], ['Cmd3CaptureApp', 'string'],
  ['Cmd3BlockersRecorded', 'uint'], ['Cmd3ItemsResolved', 'uint'], ['Cmd3NextRecorded', 'uint'], ['Cmd3WorkCommitted', 'none']
].map(([name, dataType], index) => ({ eventTypeId: 2000 + index, name, dataType }));
const customEventsHash = createHash('sha256').update(JSON.stringify(types)).digest().readUInt32BE(0) || 1;

export function projectEntityUUID(projectId) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`cmdshift3:project:${projectId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function createKeewanoIngress({
  apiKey = process.env.KEEWANO_API_KEY,
  baseUrl = process.env.CMD3_KEEWANO_BASE_URL || 'https://api.keewano.com/event/ingress/v1/json',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  let registered = false;
  let queue = Promise.resolve();

  async function request(path, body) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/${path}`);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password) {
      throw new Error('ingress_unavailable');
    }
    const result = await fetchImpl(url.href, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'k-token': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Math.min(10000, Math.max(1, timeoutMs))),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!result.ok) throw new Error('ingress_unavailable');
    if (result.status === 204) return null;
    // The acknowledgement is small; do not accept an unbounded upstream body.
    const reader = result.body?.getReader();
    if (!reader) throw new Error('ingress_unavailable');
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8192) throw new Error('ingress_unavailable');
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async function ingest(commit) {
    if (!apiKey) return { status: 'disabled' };
    if (!registered) {
      const ack = await request('custom', { customEventsHash, eventTypes: types });
      if (!ack || ack.received !== types.length || !['registered', 'already_registered', 'in_progress'].includes(ack.status)) {
        throw new Error('ingress_unavailable');
      }
      if (ack.status === 'in_progress') {
        const state = await request(`custom?customEventsHash=${customEventsHash}`);
        if (!state || state.customEventsHash !== customEventsHash || state.registered !== true) {
          return { status: 'registration_pending' };
        }
      }
      registered = true;
    }
    const values = [commit.author.id, commit.git.sha, commit.source.app_name.slice(0, 256),
      commit.fields.blocker.length, commit.fields.shipped.reduce((n, item) => n + (item.resolves?.length || 0), 0), commit.fields.next.length];
    const timestamp = Math.floor(new Date(commit.created_at).getTime() / 1000);
    const ack = await request('in', {
      dataSessionId: commit.id.replace(/^wc_/, ''), batch: 1, customEventsHash,
      installId: projectEntityUUID(commit.project_id),
      events: types.map((type, index) => ({ eventTypeId: type.eventTypeId, dataType: type.dataType, timestamp, ...(index < values.length ? { data: values[index] } : {}) }))
    });
    if (!ack || ack.received !== types.length || !Number.isInteger(ack.accepted) || ack.accepted < 0 || ack.accepted > ack.received) {
      throw new Error('ingress_unavailable');
    }
    return {
      status: ack.accepted === 0 ? 'not_accepted' : ack.accepted === types.length ? 'accepted' : 'partially_accepted',
      received: ack.received, accepted: ack.accepted
    };
  }

  return {
    queueCommittedEvent(commit) {
      if (!apiKey) return Promise.resolve({ status: 'disabled' });
      // Ingress is deliberately outside the Git transaction and cannot reject it.
      queue = queue.then(() => ingest(commit)).catch(() => ({ status: 'unavailable' }));
      return queue;
    }
  };
}

let configuredIngress;
let configuredIdentity;
export function queueCommittedEvent(commit) {
  if (!process.env.KEEWANO_API_KEY) return Promise.resolve({ status: 'disabled' });
  const identity = `${process.env.KEEWANO_API_KEY}\n${process.env.CMD3_KEEWANO_BASE_URL || ''}`;
  if (configuredIdentity !== identity) {
    configuredIngress = createKeewanoIngress();
    configuredIdentity = identity;
  }
  return configuredIngress.queueCommittedEvent(commit);
}
