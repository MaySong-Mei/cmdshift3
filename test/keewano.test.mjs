import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeewanoIngress, projectEntityUUID } from '../server/lib/keewano.mjs';

const json = (value, status = 202) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const commit = () => ({
  id: 'wc_a1e9c7d2-4f83-4b6e-9c1a-2d7f5b0e8a34', project_id: 'proj_demo',
  author: { id: 'usr_demo' }, git: { sha: 'a'.repeat(40) }, source: { app_name: 'Demo Preview' },
  created_at: '2026-10-11T22:00:00.000Z',
  fields: { blocker: [{ id: 'it_blocker' }], shipped: [{ resolves: ['it_previous'] }], next: [] }
});

function fixture(respond) {
  const requests = [];
  const client = createKeewanoIngress({ apiKey: 'test-sdk-key', fetchImpl: async (url, options) => {
    const request = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    return respond(request, requests.length);
  } });
  return { requests, send: value => client.queueCommittedEvent(value || commit()) };
}

test('Keewano disabled ingress makes no external request', async () => {
  const client = createKeewanoIngress({ apiKey: '', fetchImpl: () => assert.fail('unexpected ingress') });
  assert.deepEqual(await client.queueCommittedEvent(commit()), { status: 'disabled' });
});

test('Keewano ingress acknowledges each event and preserves typed ordered project identity', async () => {
  const f = fixture(request => request.url.endsWith('/custom') ? json({ status: 'registered', received: 7 }) : json({ received: 7, accepted: 7 }));
  assert.deepEqual(await f.send(), { status: 'accepted', received: 7, accepted: 7 });
  assert.equal(f.requests.length, 2);
  const batch = f.requests[1].body;
  assert.equal(f.requests[1].options.headers['k-token'], 'test-sdk-key');
  assert.equal(f.requests[1].options.redirect, 'error');
  assert.equal(batch.dataSessionId, commit().id.slice(3));
  assert.equal(batch.batch, 1);
  assert.equal(batch.installId, projectEntityUUID('proj_demo'));
  assert.match(batch.installId, /^[0-9a-f-]{14}5[0-9a-f-]+$/);
  assert.notEqual(batch.installId, projectEntityUUID('proj_other'));
  assert.equal(batch.events.length, 7);
  assert.equal(batch.events[1].data, 'a'.repeat(40));
  assert.equal(batch.events[3].data, 1);
  assert.equal(batch.events[4].data, 1);
  assert.equal(batch.events[6].dataType, 'none');
  assert.equal('data' in batch.events[6], false);
  assert.equal(batch.events.every(event => event.timestamp === 1791756000), true);
  await f.send();
  assert.equal(f.requests.length, 3, 'registered map is reused for this configured project key');
});

test('Keewano HTTP202 with zero or partial accepted events is not full ingress success', async () => {
  let accepted = 0;
  const f = fixture(request => request.url.endsWith('/custom') ? json({ status: 'already_registered', received: 7 }, 200) : json({ received: 7, accepted }));
  assert.deepEqual(await f.send(), { status: 'not_accepted', received: 7, accepted: 0 });
  accepted = 4;
  assert.deepEqual(await f.send(), { status: 'partially_accepted', received: 7, accepted: 4 });
});

test('Keewano in-progress registration is checked before any event writes', async () => {
  const f = fixture(request => {
    if (request.options.method === 'GET') {
      assert.equal(new URL(request.url).searchParams.get('customEventsHash'), String(f.requests[0].body.customEventsHash));
      return json({ customEventsHash: f.requests[0].body.customEventsHash, registered: true }, 200);
    }
    return request.url.endsWith('/custom') ? json({ status: 'in_progress', received: 7 }) : json({ received: 7, accepted: 7 });
  });
  assert.equal((await f.send()).status, 'accepted');
  assert.deepEqual(f.requests.map(request => request.options.method), ['POST', 'GET', 'POST']);
});

test('Keewano pending or invalid registration does not send a batch', async () => {
  const pending = fixture(request => request.options.method === 'GET' ? new Response(null, { status: 204 }) : json({ status: 'in_progress', received: 7 }));
  assert.deepEqual(await pending.send(), { status: 'registration_pending' });
  assert.equal(pending.requests.length, 2);
  const invalid = fixture(() => json({ status: 'registered', received: 0 }));
  assert.deepEqual(await invalid.send(), { status: 'unavailable' });
  assert.equal(invalid.requests.length, 1);
});

test('Keewano malformed acknowledgements and failures are sanitized and do not poison the queue', async () => {
  let first = true;
  const f = fixture(request => {
    if (request.url.endsWith('/custom')) return json({ status: 'registered', received: 7 });
    if (first) { first = false; throw new Error('test-sdk-key secret provider failure'); }
    return json({ received: 7, accepted: 7 });
  });
  assert.deepEqual(await f.send(), { status: 'unavailable' });
  assert.equal((await f.send()).status, 'accepted');
  for (const ack of [{}, { received: 7, accepted: 8 }, { received: 7, accepted: -1 }, { received: 7, accepted: 1.5 }, { received: 6, accepted: 6 }]) {
    const malformed = fixture(request => request.url.endsWith('/custom') ? json({ status: 'registered', received: 7 }) : json(ack));
    assert.deepEqual(await malformed.send(), { status: 'unavailable' });
  }
});
