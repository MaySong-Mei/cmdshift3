import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const password = 'correct horse battery staple';
const fieldNames = ['shipped','decision','why','blocker','next'];
const emptyFields = () => Object.fromEntries(fieldNames.map(name => [name, []]));
const work = project_id => ({ id: `wc_${randomUUID()}`, project_id, image_base64: PNG, annotations: [{ type:'rect',x:.1,y:.1,w:.4,h:.4,color:'#FFCC00' }], source:{app_name:'Public demo',window_title:'Evidence',capture_kind:'region'},comment:'shipped: Reviewed the release',summary:'Release reviewed',fields:emptyFields() });
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t, options = {}) {
  const keys = ['CMD3_AI_API_KEY','CMD3_AI_MODEL','CMD3_AI_PROVIDER','CMD3_AI_BASE_URL','CMD3_PUBLIC_REGISTRATION','CMD3_ALLOWED_ORIGINS'];
  const env = new Map(keys.map(key => [key,process.env[key]])); for (const key of keys) delete process.env[key];
  const dataDir = await mkdtemp(path.join(tmpdir(),'cmd3-public-')); let app; let base;
  const start = async () => { app = await createApp({mode:'public',dataDir,...options}); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`; };
  await start();
  t.after(async () => { await app.close(); await rm(dataDir,{recursive:true,force:true}); for (const [key,value] of env) if (value === undefined) delete process.env[key]; else process.env[key]=value; });
  const request = (method, endpoint, token, input, extraHeaders={}) => fetch(`${base}${endpoint}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(input===undefined?{}:{'Content-Type':'application/json'}),...extraHeaders},...(input===undefined?{}:{body:JSON.stringify(input)})});
  const json = async (method, endpoint, token, input, expected=200) => { const response=await request(method,endpoint,token,input);const result=await response.json();assert.equal(response.status,expected,`${endpoint}: ${JSON.stringify(result)}`);return result; };
  const account = (username,name=username) => json('POST','/api/accounts',null,{username,name,password},201);
  const project = (owner,input={}) => json('POST','/api/projects',owner.token,{name:'Release project',description:'A shared deliverable',context:'Ship a reviewed release',phase:'Building',deadline:'2026-10-11',...input},201).then(value=>value.project);
  return {get app(){return app;},get base(){return base;},dataDir,json,request,account,project,restart:async mutate=>{await app.close();if(mutate)await mutate();await start();}};
}
async function fakeProvider(t, respond) {
  let calls=0;
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));calls++;const value=await respond(input,calls);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {get calls(){return calls;},base:`http://127.0.0.1:${server.address().port}/v1`};
}
const completion = value => ({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('public accounts are independent, salted, private and expire after 30 days; native codes rotate', async t=>{
  const f=await fixture(t);const health=await f.json('GET','/api/health');assert.equal(health.mode,'public');assert.equal(health.public_registration,true);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);assert.deepEqual(f.app.store.allProjects(),[]);
  await f.json('POST','/api/session',null,{code:'may-demo'},401);await f.json('POST','/api/session',null,{code:'gary-demo'},401);
  const a=await f.account('alice','Alice');const b=await f.account('bob','Bob');assert.deepEqual(a.projects,[]);assert.notEqual(a.user.id,b.user.id);
  const rows=f.app.store.db.prepare('SELECT * FROM credentials').all();assert.equal(rows.length,2);assert.notEqual(rows[0].salt,rows[1].salt);assert.notEqual(rows[0].password_hash,rows[1].password_hash);assert.equal(rows[0].password_hash.length,128);assert.ok(!JSON.stringify(rows).includes(password));
  const session=f.app.store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(a.token));assert.ok(session);assert.ok(Date.parse(session.expires_at)-Date.parse(session.created_at)>=29*86400000);
  await f.json('POST','/api/accounts',null,{username:'alice',name:'Other',password},409);
  await f.json('POST','/api/session',null,{username:'alice',password:'wrong'},401);
  const logged=await f.json('POST','/api/session',null,{username:'alice',password});assert.deepEqual(logged.user,a.user);
  const first=await f.json('POST','/api/me/access-code',a.token,{});assert.ok(first.code.startsWith('mac_'));
  assert.equal(f.app.store.db.prepare('SELECT code_hash FROM access_codes').get().code_hash,sha(first.code));
  const native=await f.json('POST','/api/session',null,first);assert.deepEqual(native.user,a.user);
  const second=await f.json('POST','/api/me/access-code',a.token,{});assert.notEqual(first.code,second.code);await f.json('POST','/api/session',null,first,401);await f.json('POST','/api/session',null,second);
  const me=await f.json('GET','/api/me',a.token);assert.deepEqual(me.user,a.user);assert.ok(!JSON.stringify(me).includes('hash'));assert.ok(!JSON.stringify(me).includes(first.code));
  f.app.store.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00.000Z',sha(a.token));await f.json('GET','/api/me',a.token,undefined,401);
  await f.json('POST','/api/session/logout',native.token,{});await f.json('GET','/api/me',native.token,undefined,401);
});

test('public input bounds, signup allowance, owned project caps and origin policy are enforced',async t=>{
  const f=await fixture(t,{signupsPerHour:2,maxOwnedProjects:1});
  for(const input of [{username:'AA',name:'Name',password},{username:'user',name:'',password},{username:'user',name:'Name',password:'short'},{username:'user',name:'Name',password:'x'.repeat(129)}])await f.json('POST','/api/accounts',null,input,400);
  const a=await f.account('alice');await f.account('bob');await f.json('POST','/api/accounts',null,{username:'eve',name:'Eve',password},429);
  for(const deadline of ['2026-02-30','9999-99-99','2026-1-1'])await f.json('POST','/api/projects',a.token,{name:'Deadline',deadline},400);
  const p=await f.project(a,{context:'',phase:'',deadline:''});assert.equal(p.context,'');assert.equal(p.phase,'');assert.equal(p.deadline,'');
  await f.json('POST','/api/projects',a.token,{name:'Second'},429);
  const cross=await f.request('GET','/api/me',a.token,undefined,{Origin:'https://attacker.example'});assert.equal(cross.status,403);assert.equal(cross.headers.get('access-control-allow-origin'),null);
  const local=await f.request('GET','/api/me',a.token,undefined,{Origin:f.base});assert.equal(local.status,200);assert.equal(local.headers.get('access-control-allow-origin'),f.base);
  const native=await f.request('GET','/api/me',a.token);assert.equal(native.status,200);assert.equal(native.headers.get('access-control-allow-origin'),null);
});

test('private invitations rotate and expire; project background keeps confirmed versions and owner authority',async t=>{
  const f=await fixture(t);const a=await f.account('alice','Alice');const b=await f.account('bob','Bob');const outsider=await f.account('eve');const p=await f.project(a);
  assert.equal(p.owner_id,a.user.id);assert.equal(p.member_count,1);assert.equal(p.version,1);assert.match(p.id,/^proj_[0-9a-f-]{36}$/);
  await f.json('GET',`/api/projects/${p.id}/context`,outsider.token,undefined,403);await f.json('POST',`/api/projects/${p.id}/invite`,outsider.token,{},403);
  const old=await f.json('POST',`/api/projects/${p.id}/invite`,a.token,{});const invite=await f.json('POST',`/api/projects/${p.id}/invite`,a.token,{});assert.notEqual(old.invite_code,invite.invite_code);
  assert.equal(f.app.store.db.prepare('SELECT code_hash FROM project_invites WHERE project_id=?').get(p.id).code_hash,sha(invite.invite_code));
  await f.json('POST','/api/projects/join',b.token,{code:old.invite_code},404);
  const joined=await f.json('POST','/api/projects/join',b.token,{code:invite.invite_code});assert.equal(joined.project.member_count,2);
  await f.json('POST',`/api/projects/${p.id}/invite`,b.token,{},403);
  const updated={name:'Reviewed release',description:p.description,context:'Ship only after peer review',phase:'Review',deadline:'2026-10-12',expected_version:1};
  await f.json('POST',`/api/projects/${p.id}/context`,b.token,updated,403);
  const races=await Promise.all([f.request('POST',`/api/projects/${p.id}/context`,a.token,updated),f.request('POST',`/api/projects/${p.id}/context`,a.token,{...updated,context:'Stale alternative'})]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  const context=await f.json('GET',`/api/projects/${p.id}/context`,b.token);assert.equal(context.project.version,2);assert.equal(context.history.length,2);assert.equal(context.history[1].context,p.context);assert.deepEqual(context.history[0].updated_by,a.user);assert.deepEqual(new Set(context.members.map(m=>m.id)),new Set([a.user.id,b.user.id]));assert.ok(!JSON.stringify(context).includes(invite.invite_code));
  f.app.store.db.prepare('UPDATE project_invites SET expires_at=? WHERE project_id=?').run('2000-01-01T00:00:00.000Z',p.id);await f.json('POST','/api/projects/join',outsider.token,{code:invite.invite_code},404);
});

test('dynamic project Git history, account sessions and background survive restart, with private evidence and idempotent capped retries',async t=>{
  const f=await fixture(t,{projectCommitLimit:1});const a=await f.account('alice');const b=await f.account('bob');const p=await f.project(a);const payload=work(p.id);
  const original=(await f.json('POST','/api/commits',a.token,payload,201)).commit;assert.equal(original.git.remote_synced,true);assert.equal(original.evidence.image_bytes,Buffer.from(PNG,'base64').length);
  const origin=path.join(f.dataDir,'projects',p.id,'origin.git');assert.equal(execFileSync('git',['-C',origin,'rev-parse','main'],{encoding:'utf8'}).trim(),original.git.sha);
  for(const endpoint of [`/api/projects/${p.id}/commits`,`/api/commits/${original.id}`,`/api/evidence/${original.id}`,`/api/commits/${original.id}/comments`])await f.json('GET',endpoint,b.token,undefined,403);
  await f.json('POST','/api/commits',a.token,work(p.id),507);const retry=(await f.json('POST','/api/commits',a.token,payload)).commit;assert.equal(retry.git.sha,original.git.sha);
  f.app.store.db.prepare('DELETE FROM commit_records WHERE id=?').run(original.id);await f.restart();
  const recovered=(await f.json('GET',`/api/commits/${original.id}`,a.token)).commit;assert.equal(recovered.git.sha,original.git.sha);assert.equal((await f.json('GET',`/api/projects/${p.id}/context`,a.token)).history.length,1);
  assert.equal((await f.json('POST','/api/commits',a.token,payload)).commit.git.sha,original.git.sha);
  const image=await f.request('GET',`/api/evidence/${original.id}`,a.token);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(PNG,'base64'));
  const invite=await f.json('POST',`/api/projects/${p.id}/invite`,a.token,{});await f.json('POST','/api/projects/join',b.token,{code:invite.invite_code});
  const comment=(await f.json('POST',`/api/commits/${original.id}/comments`,b.token,{body:'Reviewed the evidence'},201)).comment;assert.equal(comment.author.id,b.user.id);await f.json('POST','/api/commits',b.token,payload,409);
  await f.json('POST',`/api/projects/${p.id}/seen`,b.token,{through_sequence:1});assert.equal((await f.json('GET',`/api/projects/${p.id}/catchup`,a.token)).since_sequence,0);
});

test('global measured disk limit rejects new commits without obstructing frozen payload retry',async t=>{
  const f=await fixture(t);const a=await f.account('alice');const p=await f.project(a);const payload=work(p.id);const original=(await f.json('POST','/api/commits',a.token,payload,201)).commit;
  await f.app.close();const options={mode:'public',dataDir:f.dataDir,totalStorageBytes:1};const app=await createApp(options);await app.listen();
  try {const endpoint=`http://127.0.0.1:${app.server.address().port}/api/commits`;const call=input=>fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});const retry=await call(payload);assert.equal(retry.status,200);assert.equal((await retry.json()).commit.git.sha,original.git.sha);const newWork=await call(work(p.id));assert.equal(newWork.status,507);}finally{await app.close();}
});

test('AI quota is persistent and counts actual calls only: manual, empty, cache and coalesced requests are exempt',async t=>{
  const f=await fixture(t,{aiUserDaily:2,aiGlobalDaily:3});const a=await f.account('alice');const b=await f.account('bob');const p=await f.project(a);const invite=await f.json('POST',`/api/projects/${p.id}/invite`,a.token,{});await f.json('POST','/api/projects/join',b.token,{code:invite.invite_code});
  const endpoint=`/api/projects/${p.id}/catchup`;await f.json('GET',endpoint,a.token);await f.json('POST','/api/draft',a.token,{project_id:p.id,comment:'manual',source:work(p.id).source});assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n,0);
  const provider=await fakeProvider(t,input=>completion(input.text.format.name==='work_deliverable'?{summary:'Reviewed release',fields:emptyFields(),warnings:[]}:{summary:'Alice reviewed the release. No blockers are recorded.'}));
  process.env.CMD3_AI_API_KEY='fake-local-only';process.env.CMD3_AI_MODEL='fake-model';process.env.CMD3_AI_BASE_URL=provider.base;
  await f.json('GET',endpoint,a.token);assert.equal(provider.calls,0,'empty catch-up never calls model');
  await f.json('POST','/api/draft',a.token,{project_id:p.id,comment:'Reviewed',source:work(p.id).source});assert.equal(provider.calls,1);
  await f.json('POST','/api/commits',a.token,work(p.id),201);const results=await Promise.all([f.json('GET',endpoint,a.token),f.json('GET',endpoint,a.token)]);assert.deepEqual(results[0],results[1]);assert.equal(provider.calls,2);
  await f.json('GET',endpoint,a.token);await f.json('POST','/api/draft',a.token,{project_id:p.id,comment:'Again',source:work(p.id).source},429);assert.equal(provider.calls,2);
  await f.json('GET',endpoint,b.token);assert.equal(provider.calls,3);await f.json('POST','/api/draft',b.token,{project_id:p.id,comment:'Again',source:work(p.id).source},429);assert.equal(provider.calls,3);
  await f.restart();await f.json('GET',endpoint,a.token,undefined,429);assert.equal(provider.calls,3);assert.equal(f.app.store.db.prepare('SELECT SUM(calls) AS n FROM ai_usage').get().n,3);
});

test('DeepSeek repair requests also consume allowance and cannot hide quota rejection as AI failure',async t=>{
  const f=await fixture(t,{aiUserDaily:1});const a=await f.account('alice');const p=await f.project(a);
  const provider=await fakeProvider(t,()=>({choices:[{finish_reason:'stop',message:{content:'{"summary":"Missing required fields"}'}}]}));
  process.env.CMD3_AI_PROVIDER='deepseek';process.env.CMD3_AI_API_KEY='fake-local-only';process.env.CMD3_AI_MODEL='fake-model';process.env.CMD3_AI_BASE_URL=provider.base;
  const result=await f.json('POST','/api/draft',a.token,{project_id:p.id,comment:'Review',source:work(p.id).source},429);assert.equal(result.error.code,'ai_quota_exceeded');assert.equal(provider.calls,1);
});

test('SSE enforces connection limits and ends expired sessions during heartbeat',async t=>{
  const f=await fixture(t,{ssePerUser:1,sseHeartbeatMs:20});const a=await f.account('alice');const p=await f.project(a);const endpoint=`/api/projects/${p.id}/events`;const controller=new AbortController();
  const response=await fetch(`${f.base}${endpoint}`,{headers:{Authorization:`Bearer ${a.token}`},signal:controller.signal});const reader=response.body.getReader();
  try {assert.equal(response.status,200);await reader.read();await f.json('GET',endpoint,a.token,undefined,429);f.app.store.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00.000Z',sha(a.token));let done=false;while(!done)done=(await reader.read()).done;assert.equal(done,true);}finally{controller.abort();await reader.cancel().catch(()=>{});}
});

test('public mode refuses existing local demo history instead of exposing demo memberships',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'cmd3-demo-isolation-'));t.after(()=>rm(dir,{recursive:true,force:true}));const demo=await createApp({dataDir:dir,mode:'demo'});await demo.close();await assert.rejects(createApp({dataDir:dir,mode:'public'}),/separate data directory/);
});

test('confirmed project context reaches both AI stages and a new version invalidates catch-up cache',async t=>{
  const organized=[];const summarized=[];
  const f=await fixture(t,{organizeDeliverable:async input=>{organized.push(input);return {summary:'Reviewed',fields:emptyFields(),organizer:{provider:'manual',status:'not_configured'},warnings:[]};},summarizeProject:async input=>{summarized.push(input);return {summary:`Background version ${input.project.version}`,analyzer:{provider:'manual',status:'not_configured'}};}});
  const a=await f.account('alice');const p=await f.project(a);await f.json('POST','/api/draft',a.token,{project_id:p.id,source:work(p.id).source,comment:'Reviewed',project:{context:'Spoofed client context'}});
  assert.equal(organized[0].project.context,p.context);assert.equal(organized[0].project.version,1);assert.equal(organized[0].project.owner_id,undefined);
  await f.json('POST','/api/commits',a.token,work(p.id),201);const endpoint=`/api/projects/${p.id}/catchup`;const first=await f.json('GET',endpoint,a.token);await f.json('GET',endpoint,a.token);assert.equal(summarized.length,1);
  await f.json('POST',`/api/projects/${p.id}/context`,a.token,{name:p.name,context:'Reviewed human goal',expected_version:1});const second=await f.json('GET',endpoint,a.token);assert.equal(summarized.length,2);assert.notEqual(first.summary,second.summary);assert.equal(summarized[1].project.context,'Reviewed human goal');assert.equal(summarized[0].project.context,p.context,'prior in-flight snapshot stays fixed');
});

test('AI concurrency rejects overload without charging a second request and releases after completion',async t=>{
  const f=await fixture(t,{maxAIConcurrency:1});const a=await f.account('alice');const p=await f.project(a);const gate=Promise.withResolvers();const started=Promise.withResolvers();t.after(()=>gate.resolve());
  const provider=await fakeProvider(t,async()=>{started.resolve();await gate.promise;return completion({summary:'Reviewed',fields:emptyFields(),warnings:[]});});process.env.CMD3_AI_API_KEY='fake-local-only';process.env.CMD3_AI_MODEL='fake-model';process.env.CMD3_AI_BASE_URL=provider.base;
  const input={project_id:p.id,source:work(p.id).source,comment:'Review'};const pending=f.json('POST','/api/draft',a.token,input);await started.promise;
  try {const busy=await f.json('POST','/api/draft',a.token,input,429);assert.equal(busy.error.code,'ai_busy');assert.equal(provider.calls,1);assert.equal(f.app.store.db.prepare('SELECT SUM(calls) AS n FROM ai_usage').get().n,1);}finally{gate.resolve();await pending;}
  await f.json('POST','/api/draft',a.token,input);assert.equal(provider.calls,2);
});
