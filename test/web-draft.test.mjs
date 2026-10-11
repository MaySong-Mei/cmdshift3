import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the browser's actual pure merge policy without a DOM or any network calls.
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const names=source.match(/^const FIELD_NAMES = \[[^\n]+\];/m)?.[0];
const helper=source.match(/function draftResultUpdate\(current, result\) \{[\s\S]*?(?=\nfunction loginScreen)/)?.[0];
assert.ok(names&&helper,'The browser draft merge policy must be available to this test.');
const update=vm.runInNewContext(`${names}\n${helper}\ndraftResultUpdate`,{});
const emptyFields=()=>({shipped:[],decision:[],why:[],blocker:[],next:[]});
const plain=value=>JSON.parse(JSON.stringify(value));
const failure=fields=>({summary:'Automatically extracted fallback title',fields,organizer:{provider:'manual',status:'ai_unavailable'}});

test('an unavailable model cannot erase a reviewed deliverable or its resolution references',()=>{
  const fields={...emptyFields(),shipped:[{id:'it_reviewed',text:'Auth is fixed',resolves:['it_auth_blocker']}],decision:[{id:'it_choice',text:'Keep the current endpoint'}]};
  const current={summary:'My edited title',fields,resolveIds:['it_auth_blocker'],comment:'Original context',image:'original-capture'};
  const snapshot=plain(current);
  const merged={...current,...update(current,failure(emptyFields()))};
  assert.deepEqual(plain(merged),{...snapshot,organizer:{provider:'manual',status:'ai_unavailable'}});
  assert.strictEqual(merged.fields,fields,'Edited work items must survive the fallback unchanged.');
  assert.strictEqual(merged.resolveIds,current.resolveIds,'Explicitly selected references must survive.');
  assert.deepEqual(plain(current),snapshot,'Applying the policy must not mutate its input.');
});

test('an empty deliverable can use explicit-label manual fallback fields',()=>{
  const fields={...emptyFields(),blocker:[{id:'it_labelled',text:'Waiting for access'}]};
  const current={summary:'',fields:emptyFields(),resolveIds:[]};
  const result=update(current,failure(fields));
  assert.equal(result.summary,'Automatically extracted fallback title');
  assert.deepEqual(plain(result.fields),fields);
  assert.deepEqual(plain(result.resolveIds),[]);
  assert.equal(result.organizer.status,'ai_unavailable');
});

test('manual fallback fills empty fields while retaining an edited title and selected references',()=>{
  const current={summary:'Title already reviewed',fields:emptyFields(),resolveIds:['it_open_next']};
  const result=update(current,failure({...emptyFields(),shipped:[{id:'it_fallback',text:'Fix completed'}]}));
  assert.equal(result.summary,current.summary);
  assert.deepEqual(plain(result.resolveIds),['it_open_next']);
  assert.equal(result.fields.shipped[0].text,'Fix completed');
});

test('successful organization replaces the draft and preserves model-supplied resolution IDs',()=>{
  const current={summary:'Old title',fields:{...emptyFields(),blocker:[{id:'it_old',text:'Old blocker'}]},resolveIds:['it_previous']};
  const result={summary:'New organized title',fields:{...emptyFields(),shipped:[{id:'it_new',text:'Handoff works',resolves:['it_handoff','it_handoff']}]},organizer:{provider:'deepseek',status:'completed'}};
  const next=update(current,result);
  assert.equal(next.summary,result.summary);
  assert.deepEqual(plain(next.fields),result.fields);
  assert.deepEqual(plain(next.resolveIds),['it_handoff']);
  assert.strictEqual(next.organizer,result.organizer);
  assert.equal(current.fields.blocker[0].id,'it_old');
});
