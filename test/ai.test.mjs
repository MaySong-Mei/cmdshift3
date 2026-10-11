import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { organizeDeliverable, summarizeProject, providerStatus } from '../server/lib/ai.mjs';

test('manual review preserves unlabeled facts and requires explicit classification', async () => {
  delete process.env.CMD3_AI_API_KEY;
  const draft = await organizeDeliverable({ comment: 'The prototype might be done' });
  assert.equal(draft.summary, 'The prototype might be done');
  assert.deepEqual(draft.fields.shipped, []);
  assert.equal(draft.organizer.status, 'not_configured');
  const explicit = await organizeDeliverable({ comment: '完成：菜单栏入口\nblocker: Waiting for approval\nnext: Record demo' });
  assert.equal(explicit.fields.shipped[0].text, '菜单栏入口');
  assert.deepEqual(explicit.fields.shipped[0].resolves, []);
  assert.equal(explicit.fields.blocker[0].text, 'Waiting for approval');
  assert.match(explicit.fields.next[0].id, /^it_[0-9a-f-]{36}$/);
  const summary = await summarizeProject({ commits: [{ author: { name: 'May' }, summary: 'Menu bar shipped' }], state: { blockers: [{ text: 'Waiting for approval' }], next: [] } });
  assert.match(summary.summary, /Still blocked: Waiting for approval/);
  assert.equal(summary.analyzer.provider, 'manual');
});

test('real provider request carries screenshot, strict schema and explicit evidence; malformed responses fall back', async t => {
  const requests = [];
  let failure = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (failure) { res.writeHead(503); res.end(); return; }
    const fields = { shipped: [{ text: 'Fixed login', resolves: ['it_known', 'it_fabricated'] }], decision: [], why: [], blocker: [], next: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Fixed login', fields, warnings: [] }) }] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = Object.fromEntries(['CMD3_AI_API_KEY','CMD3_AI_MODEL','CMD3_AI_BASE_URL'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.CMD3_AI_API_KEY = 'test-only-key'; process.env.CMD3_AI_MODEL = 'test-model';
  process.env.CMD3_AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const result = await organizeDeliverable({ comment: 'Fixed login', image_base64: 'testPNG', state: { blockers: [{ id: 'it_known', text: 'Login broken' }] } });
  assert.equal(result.organizer.provider, 'openai');
  assert.deepEqual(result.fields.shipped[0].resolves, ['it_known']);
  assert.equal(requests[0].path, '/v1/responses');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.text.format.strict, true);
  assert.equal(requests[0].body.input[0].content[1].image_url, 'data:image/png;base64,testPNG');
  assert.equal(providerStatus().ai.configured, true);
  failure = true;
  const fallback = await organizeDeliverable({ comment: 'blocker: Still waiting' });
  assert.equal(fallback.organizer.status, 'ai_unavailable');
  assert.equal(fallback.fields.blocker[0].text, 'Still waiting');
});
