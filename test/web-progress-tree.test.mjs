import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the browser's actual task/author policy without a DOM or model calls.
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const start=source.indexOf('function progressTreeData('),end=source.indexOf('function progressEvidenceMarkup(');
assert.ok(start!==-1&&end>start,'Progress task and color helpers must be available.');
const {tree,colors}=vm.runInNewContext(`${source.slice(start,end)}\n({tree:progressTreeData,colors:progressMemberColors})`);
const fields=values=>({shipped:[],decision:[],why:[],blocker:[],next:[],...values});
const may={id:'usr_may',name:'May'},gary={id:'usr_gary',name:'Gary'};
const record=(sequence,author,values={},extra={})=>({
  id:`wc_${sequence}`,project_id:'proj_demo',sequence,author,fields:fields(values),
  summary:`Work ${sequence}`,created_at:'2026-10-11T21:00:00Z',source:{app_name:'Terminal'},
  git:{sha:`sha${sequence}`,remote_synced:true},...extra,
});
const plain=value=>JSON.parse(JSON.stringify(value));

test('only explicit shipped resolutions join a teammate contribution to the original task',()=>{
  const original=record(1,may,{blocker:[{id:'it_review',text:'Waiting for release review'}],next:[{id:'it_video',text:'Record the demo'}]});
  const unrelated=record(2,gary,{shipped:[{id:'it_docs',text:'Published the guide'}]});
  const completion=record(3,gary,{shipped:[{id:'it_approved',text:'Reviewed the release',resolves:['it_review']}]});
  const result=tree([completion,unrelated,original],'proj_demo',may.id,[may,gary]);
  const review=result.tasks.find(task=>task.id==='it_review');
  assert.equal(review.status,'completed');
  assert.equal(review.recorded_by.id,may.id,'The creator is recorded, not reassigned to the reviewer.');
  assert.deepEqual(plain(review.evidence.map(item=>[item.author.id,item.commit_id,item.git_sha,item.mine])),[
    ['usr_may','wc_1','sha1',true],['usr_gary','wc_3','sha3',false],
  ]);
  assert.equal(result.tasks.find(task=>task.id==='it_video').status,'open');
  assert.equal(result.tasks.find(task=>task.id==='it_docs').status,'completed');
  assert.equal(result.tasks.some(task=>task.id==='it_approved'),false,'Explicitly linked completion is evidence under the original task.');
  assert.equal(result.commit_count,3);
  assert.equal(result.mine_count,1,'Count confirmed authored commits, not assigned work or repeated leaves.');
});

test('a later capture or a decision does not implicitly complete a blocked task',()=>{
  const original=record(1,may,{blocker:[{id:'it_access',text:'Waiting for access'}]});
  const capture=record(2,gary,{}, {summary:'A screen showing the release'});
  const decision=record(3,gary,{decision:[{id:'it_choice',text:'Keep the current service'}]});
  const result=tree([decision,capture,original],'proj_demo',gary.id);
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].status,'blocked');
  assert.equal(result.tasks[0].evidence.length,1);
  assert.deepEqual(plain(result.supporting.map(item=>item.commit_id)),['wc_3','wc_2']);
  assert.equal(result.supporting[1].role,'Supporting record');
});

test('unknown, future or non-shipped references cannot close a task',()=>{
  const before=record(1,gary,{shipped:[{id:'it_before',text:'Some work shipped',resolves:['it_future']}]});
  const task=record(2,may,{blocker:[{id:'it_future',text:'A newly recorded blocker'}]});
  const wrongField=record(3,gary,{decision:[{id:'it_wrong',text:'Decision recorded',resolves:['it_future']}]});
  const unknown=record(4,gary,{shipped:[{id:'it_other',text:'Other work shipped',resolves:['it_unknown']}]});
  const result=tree([unknown,wrongField,task,before],'proj_demo',may.id);
  assert.equal(result.tasks.find(item=>item.id==='it_future').status,'blocked');
  assert.equal(result.tasks.find(item=>item.id==='it_future').evidence.length,1);
  assert.equal(result.tasks.find(item=>item.id==='it_other').status,'completed','The confirmed shipped statement remains its own contribution.');
});

test('one explicit completion can resolve the recorded blocker and next item without inventing a dependency',()=>{
  const first=record(1,may,{blocker:[{id:'it_block',text:'Review pending'}],next:[{id:'it_next',text:'Complete review'}]});
  const done=record(2,gary,{shipped:[{id:'it_done',text:'Review completed',resolves:['it_block','it_next','it_block']}]});
  const result=tree([done,first],'proj_demo',gary.id);
  assert.equal(result.tasks.length,2);
  for(const task of result.tasks){
    assert.equal(task.status,'completed');
    assert.equal(task.evidence.length,2,'Duplicate references cannot duplicate a contribution.');
    assert.equal(task.evidence[1].mine,true);
  }
});

test('project isolation and input immutability preserve the authenticated history',()=>{
  const selected=record(1,may,{next:[{id:'it_next',text:'Record the demo'}]});
  const other=record(2,gary,{shipped:[{id:'it_done',text:'Finished elsewhere',resolves:['it_next']}]},{project_id:'proj_other'});
  const input=[other,selected],snapshot=plain(input);
  const result=tree(input,'proj_demo',may.id,[may,gary]);
  assert.deepEqual(plain(input),snapshot);
  assert.equal(result.commit_count,1);
  assert.equal(result.tasks[0].status,'open');
  assert.equal(result.tasks[0].evidence[0].git_sha,'sha1');
  assert.deepEqual(plain(result.members.map(member=>member.name)),['Gary','May'],'Project members can appear in the color legend before contributing.');
});

test('observed members have distinct colors that remain stable when new contributors arrive',()=>{
  const registry=new Map();
  colors([may,gary],registry);
  const mayColor=registry.get(may.id),garyColor=registry.get(gary.id);
  assert.notEqual(mayColor,garyColor);
  const newcomers=Array.from({length:25},(_,index)=>({id:`usr_member_${index}`,name:`Member ${index}`}));
  colors([...newcomers,gary,may],registry);
  assert.equal(registry.get(may.id),mayColor);
  assert.equal(registry.get(gary.id),garyColor);
  assert.equal(new Set(registry.values()).size,registry.size);
});
