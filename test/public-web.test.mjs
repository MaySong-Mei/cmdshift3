import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
// Load the actual browser functions with a tiny UI boundary. No mock server or
// provider is needed for these authentication, secret, and request-race checks.
function browserBoundary() {
  const nodes=new Map(),storage=new Map(),calls=[];
  function node(id) {
    if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',open:false,disabled:false,
      listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},
      showModal(){this.open=true;},close(){this.open=false;this.listeners.get('close')?.();},
      focus(){},classList:{add(){},remove(){},toggle(){}},querySelector(selector){return node(selector);},querySelectorAll(){return [];}});
    return nodes.get(id);
  }
  const context=vm.createContext({document:{querySelector:node,querySelectorAll(){return [];},addEventListener(){}},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    window:{addEventListener(){}},location:{origin:'https://example.test'},navigator:{clipboard:{writeText:async()=>{}}},
    crypto:{randomUUID:()=> 'uuid'},URL,Headers,DOMException,AbortController,setTimeout,clearTimeout,Date,
    fetch:async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>({})};}});
  vm.runInContext(source.replace(/\nboot\(\);\s*$/,'\n'),context);
  return {context,nodes,storage,calls,node,run:code=>vm.runInContext(code,context)};
}

test('public authentication hides shared demo identities and safely escapes usernames',()=>{
  const ui=browserBoundary();
  ui.run("state.mode='public';state.publicRegistration=true;publicLoginScreen('', 'signin', '<script>');");
  const html=ui.node('#app').innerHTML;
  assert.match(html,/EARLY ACCESS/);assert.match(html,/Create account/);
  assert.match(html,/type="password"/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/may-demo|gary-demo|Continue as May|Continue as Gary|Demo access code/);
  ui.run("publicLoginScreen('', 'create');");
  const signup=ui.node('#app').innerHTML;
  assert.match(signup,/minlength="12"/);assert.match(signup,/Password recovery is not available/);
  assert.match(signup,/no email is collected/);assert.match(signup,/id="account-name"/);
});

test('opening the Mac and invitation panels does not create secret codes',()=>{
  const ui=browserBoundary();
  ui.run("state.mode='public';state.user={id:'user_a',name:'A'};state.project={id:'project_a',owner_id:'user_a',name:'Private project'};openMacConnection();");
  assert.equal(ui.calls.length,0);
  assert.match(ui.node('#workspace-dialog').innerHTML,/https:\/\/example\.test/);
  assert.match(ui.node('#workspace-dialog').innerHTML,/replaces your previous Mac sign-in code/);
  assert.doesNotMatch(ui.node('#workspace-dialog').innerHTML,/id="personal-mac-code"/);
  ui.run('openProjectInvite();');
  assert.equal(ui.calls.length,0);assert.doesNotMatch(ui.node('#workspace-dialog').innerHTML,/id="generated-invite-code"/);
});

test('dialog close invalidates pending responses and removes displayed secrets',()=>{
  const ui=browserBoundary();
  ui.run("state.epoch=3;const ticket=openWorkspaceDialog('Secret','a-secret-value');");
  assert.equal(ui.run('workspaceDialogCurrent(ticket)'),true);
  ui.node('#workspace-dialog').close();
  assert.equal(ui.run('workspaceDialogCurrent(ticket)'),false);
  assert.equal(ui.node('#workspace-dialog').innerHTML,'');
  ui.run("openWorkspaceDialog('Other','New panel');");
  assert.equal(ui.run('workspaceDialogCurrent(ticket)'),false);
  ui.run('state.epoch++;');
  assert.equal(ui.run('workspaceDialogCurrent({epoch:3,dialogEpoch:state.workspaceDialogEpoch})'),false);
});

test('project context ignores a slower previous request and a previous project',async()=>{
  const ui=browserBoundary();
  ui.run("state.mode='public';state.epoch=7;state.project={id:'project_a'};let requests=[];let applied=[];api=()=>new Promise(resolve=>requests.push(resolve));applyProjectMetadata=project=>applied.push(project);renderContextCard=()=>{};");
  const first=ui.run('loadProjectContext(7)'),second=ui.run('loadProjectContext(7)');
  ui.run("requests[1]({project:{id:'project_a',name:'New'},members:[],history:[]});");await second;
  ui.run("requests[0]({project:{id:'project_a',name:'Old'},members:[],history:[]});");await first;
  assert.equal(ui.run('applied.length'),1);assert.equal(ui.run('state.context.project.name'),'New');
  const obsolete=ui.run('loadProjectContext(7)');
  ui.run("state.epoch=8;state.project={id:'project_b'};requests[2]({project:{id:'project_a',name:'Wrong project'},members:[],history:[]});");await obsolete;
  assert.equal(ui.run('applied.length'),1);assert.equal(ui.run('state.project.id'),'project_b');
});

test('date-only project deadlines retain their calendar day',()=>{
  const ui=browserBoundary();
  assert.match(ui.run("deadlineLabel('2026-10-11')"),/11/);
  assert.equal(ui.run("deadlineLabel('')"),'Not set');
});

test('a conflicting context edit keeps the draft and requires latest-version review',async()=>{
  const ui=browserBoundary();
  ui.run("state.mode='public';state.user={id:'user_a',name:'A'};state.project={id:'project_a',owner_id:'user_a',version:1,name:'Original'};state.projects=[state.project];let submitted=[];let firstSave=true;api=async(path,options)=>{if(options?.method==='POST'){submitted.push(options.body);if(firstSave){firstSave=false;const error=new Error('Context was changed');error.status=409;throw error;}return {project:{...state.project,...options.body,version:3}};}return {project:{...state.project,version:2,name:'Teammate context',context:'Latest goal'}};};renderContextCard=()=>{};loadProjectContext=()=>{};toast=()=>{};openProjectForm(state.project);");
  const form=ui.node('#project-form'),submit=form.listeners.get('submit');
  for(const [name,value] of Object.entries({name:'My reviewed name',description:'My description',context:'My detailed goal',phase:'Building',deadline:'2026-10-11'}))ui.node(`#project-form-${name}`).value=value;
  await submit({preventDefault(){}});
  assert.equal(ui.node('#project-form-context').value,'My detailed goal');
  assert.equal(ui.node('#project-form-name').value,'My reviewed name');
  assert.equal(ui.node('#project-form-submit').disabled,true);
  assert.match(ui.node('#project-conflict').innerHTML,/Latest goal/);
  ui.node('#acknowledge-context').listeners.get('click')();
  assert.equal(ui.node('#project-form-submit').disabled,false);
  await submit({preventDefault(){}});
  assert.equal(ui.run('submitted[1].expected_version'),2);
  assert.equal(ui.run('submitted[1].context'),'My detailed goal');
});

test('an obsolete authentication response cannot switch the current account',async()=>{
  const ui=browserBoundary();
  ui.run("state.mode='public';let resolveLogin;api=()=>new Promise(resolve=>resolveLogin=resolve);");
  const request=ui.run("login({username:'old_user',password:'not-a-real-password'});");
  ui.run("state.authEpoch++;resolveLogin({token:'old-session',user:{id:'old_user'},projects:[]});");
  await request;assert.equal(ui.run('state.token'),null);assert.equal(ui.storage.has('cmdshift3-token'),false);
});
