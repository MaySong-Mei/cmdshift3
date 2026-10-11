const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const FIELD_NAMES = ['shipped', 'decision', 'why', 'blocker', 'next'];
const FIELD_LABELS = {shipped:'Shipped',decision:'Decided',why:'Why',blocker:'Blocked',next:'Next'};
const uid = prefix => `${prefix}_${crypto.randomUUID()}`;
const app = $('#app');
const state = {
  token: sessionStorage.getItem('cmdshift3-token'), user: null, projects: [], project: null,
  commits: [], projectState: {shipped:[],decisions:[],blockers:[],next:[]},
  catchup: null, through: 0, epoch: 0, stream: null, images: new Map(),
  connected: false, loading: true, error: '', refreshPending: false, refreshAgain: false,
  detailId: null, detailEpoch: 0, commentRequest: 0, catchupRequest: 0, commentPosting: false, composer: null,
  mode: 'unknown', publicRegistration: false, authEpoch: 0,
  context: null, contextError: '', contextRequest: 0, contextExpanded: false, workspaceDialogEpoch: 0,
  workView: 'feed', highlightMine: true, progressColors: new Map(), progressCollapsed: new Set(),
  conversation: null,
};
let toastTimer;

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 4200);
}

async function api(path, options = {}) {
  const {token = state.token, signal, ...rest} = options;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body && typeof rest.body !== 'string') {
    headers.set('Content-Type', 'application/json'); rest.body = JSON.stringify(rest.body);
  }
  const response = await fetch(path, {...rest, headers, signal});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status}).`);
    error.status = response.status; error.code = data.error?.code;
    throw error;
  }
  return data;
}

function relativeTime(value) {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, {month:'short',day:'numeric'});
}
function fullTime(value) {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}
function initials(user) {return String(user?.name || '?').split(/\s+/).map(part => part[0]).slice(0,2).join('').toUpperCase();}
function avatar(user, extra='') {return `<span class="avatar ${String(user?.name || '').toLowerCase().includes('gary')?'gary':''} ${extra}" aria-hidden="true">${escapeHTML(initials(user))}</span>`;}
function summaryOf(commit) {return commit.summary || commit.comment || 'Work commit';}
function fieldsOf(commit) {return commit.fields || {};}
function hasResolved(commit) {return (fieldsOf(commit).shipped || []).some(item => item.resolves?.length);}
function syncBadge(commit) {return commit.git?.remote_synced ? '<span class="badge good">↗ Origin synced</span>' : '<span class="badge warning">Sync pending</span>';}
function errorText(error) {return error?.message || 'Something went wrong. Please try again.';}
function organizationNote(organizer = {}) {
  if(organizer.status==='not_prepared')return 'Draft not prepared yet. Prepare a draft to organize your comment, then review the deliverable.';
  if(organizer.provider==='manual'){
    if(organizer.status==='ai_unavailable')return 'AI temporarily unavailable · Manual review. Your capture, comment, and edited draft are preserved.';
    if(organizer.status==='not_configured')return 'Manual organization · AI is not configured. Review your words and edited draft before committing.';
    return 'Manual review · Review your words and edited draft before committing.';
  }
  return `Organized by ${organizer.provider || 'your configured provider'} · Review before committing.`;
}
function analysisNote(analyzer = {}) {
  if(analyzer.status==='no_changes')return `${analyzer.provider || 'Your configured provider'} is configured. No new updates to summarize; no model request needed.`;
  if(analyzer.provider==='manual'){
    if(analyzer.status==='ai_unavailable')return 'AI temporarily unavailable. Showing a confirmed-work fallback based on your deliverables.';
    if(analyzer.status==='not_configured')return 'AI is not configured. Showing a summary based on confirmed deliverables.';
    return 'Based on confirmed deliverables.';
  }
  return `Analysis by ${analyzer.provider || 'your configured provider'}${analyzer.status?' · '+analyzer.status:''}.`;
}
function organizationToast(organizer = {}) {
  if(organizer.provider==='manual'){
    if(organizer.status==='ai_unavailable')return 'AI temporarily unavailable. Your edited draft is preserved for manual review.';
    if(organizer.status==='not_configured')return 'AI is not configured. Draft ready for manual review.';
    return 'Draft ready for manual review.';
  }
  return `Draft organized by ${organizer.provider || 'your configured provider'}. Review it before committing.`;
}

function draftResultUpdate(current, result) {
  const organizer=result.organizer||{provider:'manual',status:'unknown'};
  const fallback=organizer.provider==='manual'&&organizer.status==='ai_unavailable';
  const hasEditedFields=FIELD_NAMES.some(name=>current.fields[name]?.length);
  const fields=fallback&&hasEditedFields?current.fields:Object.fromEntries(FIELD_NAMES.map(name=>[name,result.fields?.[name]||[]]));
  return {
    summary:fallback?(current.summary||result.summary||''):(result.summary||current.summary),
    fields,
    resolveIds:fallback?(current.resolveIds||[]):[...new Set(fields.shipped.flatMap(item=>item.resolves||[]))],
    organizer,
  };
}

function loginScreen(message='') {
  if(state.mode==='public'){publicLoginScreen(message);return;}
  app.innerHTML = `<main class="login-screen">
    <section class="login-story"><div><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><h1>Commit your work.<br>Everyone stays<br>caught up.</h1><p>A screenshot. A little context. A shared understanding of what happens next.</p>
    <div class="login-visual" aria-hidden="true"><div class="mini-window"><div class="window-dots"><i></i><i></i><i></i></div><div class="line"></div><div class="line"></div><div class="line" style="width:65%"></div><div class="line" style="width:90%"></div></div><div class="mini-commit"><span style="color:#bdc9b2">✓ Work committed</span><strong>The team is on the same page.</strong><span class="sha">Every update. A real Git commit.</span></div></div></div><p class="tiny">Made for the moments that move a project forward.</p></section>
    <section class="login-form-wrap"><div class="login-panel"><div class="eyebrow" style="margin-bottom:14px">YOUR TEAM, IN CONTEXT</div><h2>Pick up where you left off.</h2><p>Open a project to see the work, the decisions, and what your teammates need next.</p>
    <form id="login-form"><div class="form-field"><label for="invite-code">Demo access code</label><input id="invite-code" name="code" autocomplete="off" placeholder="Enter your access code" required></div><p id="login-error" class="form-error" role="alert">${escapeHTML(message)}</p><button class="button accent" type="submit">Open workspace <span aria-hidden="true">↗</span></button></form>
    <div class="login-options"><div class="eyebrow">TRY THE TEAM DEMO</div><button class="button secondary" data-demo="may-demo">${avatar({name:'May'})}<span>Continue as May</span><span class="grow"></span><span aria-hidden="true">→</span></button><button class="button secondary" data-demo="gary-demo">${avatar({name:'Gary'})}<span>Continue as Gary</span><span class="grow"></span><span aria-hidden="true">→</span></button><p>Use two tabs with different accounts to see shared updates. These are demo sessions, not production accounts.</p></div><p class="login-footnote">Screenshots stay inside the project they belong to.</p></div></section></main>`;
  $('#login-form').addEventListener('submit', event => {event.preventDefault(); login($('#invite-code').value.trim());});
  $$('[data-demo]').forEach(button => button.addEventListener('click', () => login(button.dataset.demo)));
}

async function login(credentials, createAccount=false) {
  if (!credentials) return;
  const authEpoch=++state.authEpoch;
  $$('button', app).forEach(button => button.disabled = true); $('#login-error').textContent = '';
  try {
    const result = await api(createAccount?'/api/accounts':'/api/session', {method:'POST',body:typeof credentials==='string'?{code:credentials}:credentials,token:null});
    if(authEpoch!==state.authEpoch)return;
    resetProjectConversation();
    state.token = result.token; sessionStorage.setItem('cmdshift3-token', result.token);
    state.user = result.user; state.projects = result.projects || [];
    await enterWorkspace();
  } catch (error) {
    if(authEpoch!==state.authEpoch)return;
    if(state.mode==='public')publicLoginScreen(errorText(error),createAccount?'create':'signin',credentials.username||'');
    else loginScreen(errorText(error));
  }
}

function publicLoginScreen(message='',view='signin',username='') {
  const creating=view==='create';
  app.innerHTML=`<main class="login-screen"><section class="login-story"><div><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><h1>Commit your work.<br>Everyone stays<br>caught up.</h1><p>A screenshot. A little context. A shared understanding of what happens next.</p><div class="login-visual" aria-hidden="true"><div class="mini-window"><div class="window-dots"><i></i><i></i><i></i></div><div class="line"></div><div class="line"></div><div class="line" style="width:65%"></div></div><div class="mini-commit"><span style="color:#bdc9b2">✓ Work committed</span><strong>The team is on the same page.</strong><span class="sha">Every update. A real Git commit.</span></div></div></div><p class="tiny">Small updates. Shared progress.</p></section><section class="login-form-wrap"><div class="login-panel"><div class="eyebrow" style="margin-bottom:14px">EARLY ACCESS</div><h2>${creating?'Start a shared story.':'Welcome back.'}</h2><p>${creating?'Create your account, start a private project, and invite your team.':'See what changed, what is blocked, and what comes next.'}</p><div class="auth-tabs" role="tablist" aria-label="Account access"><button role="tab" aria-selected="${!creating}" data-auth-view="signin">Sign in</button>${state.publicRegistration?`<button role="tab" aria-selected="${creating}" data-auth-view="create">Create account</button>`:''}</div><form id="login-form">${creating?'<div class="form-field"><label for="account-name">Your name</label><input id="account-name" name="name" autocomplete="name" maxlength="80" required placeholder="How your teammates know you"></div>':''}<div class="form-field"><label for="account-username">Username</label><input id="account-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="40" value="${escapeHTML(username)}" required placeholder="Your username"></div><div class="form-field"><label for="account-password">Password</label><input id="account-password" name="password" type="password" autocomplete="${creating?'new-password':'current-password'}" ${creating?'minlength="12"':''} maxlength="200" required placeholder="${creating?'At least 12 characters':'Your password'}"></div>${creating?'<p class="signup-note">Use at least 12 characters and save your password. Password recovery is not available in early access; no email is collected.</p>':''}<p id="login-error" class="form-error" role="alert">${escapeHTML(message)}</p><button class="button accent" type="submit">${creating?'Create account':'Sign in'} <span aria-hidden="true">↗</span></button></form><p class="login-footnote">Your projects are private to the members you invite.</p><a class="public-download" href="/downloads/CmdShift3.zip">Download the Mac app <span aria-hidden="true">↗</span></a></div></section></main>`;
  $$('[data-auth-view]').forEach(button=>button.addEventListener('click',()=>{state.authEpoch++;publicLoginScreen('',button.dataset.authView,$('#account-username').value);}));
  $('#login-form').addEventListener('submit',event=>{
    event.preventDefault();
    const body={username:$('#account-username').value.trim(),password:$('#account-password').value};
    if(creating)body.name=$('#account-name').value.trim();
    login(body,creating);
  });
}

async function logout() {
  const token = state.token;
  resetProjectConversation();
  state.epoch++; state.stream?.abort(); clearImages();
  state.token = null; state.user = null; sessionStorage.removeItem('cmdshift3-token');
  if(state.composer?.imageURL) URL.revokeObjectURL(state.composer.imageURL);
  state.composer = null;
  state.project=null;state.projects=[];state.context=null;state.contextError='';state.catchup=null;state.commits=[];state.authEpoch++;
  sessionStorage.removeItem('cmdshift3-project');
  $$('dialog').forEach(dialog => dialog.close());
  state.workspaceDialogEpoch++;$('#workspace-dialog').innerHTML='';
  loginScreen();
  if (token) api('/api/session/logout',{method:'POST',token}).catch(() => {});
}

async function enterWorkspace() {
  if (!state.projects.length) state.projects = (await api('/api/projects')).projects || [];
  const saved = sessionStorage.getItem('cmdshift3-project');
  const project = state.projects.find(item => item.id === saved) || state.projects[0];
  if (!project) {state.epoch++;state.project=null;renderShell();return;}
  await switchProject(project.id);
}

async function switchProject(id) {
  const project = state.projects.find(item => item.id === id); if (!project) return;
  resetProjectConversation();
  state.epoch++; state.stream?.abort(); clearImages();
  state.project = project; state.commits = []; state.catchup = null; state.through = 0;
  state.progressCollapsed.clear();
  state.context=null;state.contextError='';state.contextExpanded=false;state.contextRequest++;
  state.projectState = {shipped:[],decisions:[],blockers:[],next:[]};
  state.connected = false; state.loading = true; state.error = '';
  state.refreshPending = false; state.refreshAgain = false;
  state.detailId = null; state.detailEpoch++;
  $$('dialog').forEach(dialog => dialog.close());
  state.workspaceDialogEpoch++;$('#workspace-dialog').innerHTML='';
  sessionStorage.setItem('cmdshift3-project',id); renderShell();
  const epoch = state.epoch;
  await refreshProject(epoch);
  if (epoch === state.epoch && state.token) startStream(epoch);
}

function sidebarMarkup() {
  const publicMode=state.mode==='public';
  return `<aside class="sidebar" aria-label="Workspace navigation"><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><p class="tagline">Work, together.</p><div class="eyebrow">YOUR PROJECTS</div><nav class="project-list">${state.projects.map(item=>`<button class="project-button ${item.id===state.project?.id?'active':''}" data-project="${escapeHTML(item.id)}" ${item.id===state.project?.id?'aria-current="page"':''}><span class="project-dot" aria-hidden="true"></span>${escapeHTML(item.name)}</button>`).join('')}</nav>${publicMode?'<div class="project-actions"><button data-create-project>＋ Create project</button><button data-join-project>↗ Join with invite</button></div>':''}<div class="sidebar-note">Small updates.<br>A shared project history.</div><div class="sidebar-bottom">${publicMode?'<button class="button secondary small" id="connect-mac">Connect Mac app <span aria-hidden="true">↗</span></button><a class="sidebar-download" href="/downloads/CmdShift3.zip">Download for Mac</a>':''}<span class="badge">${publicMode?'Early access':'Demo workspace'}</span><div class="session-card"><div class="row">${avatar(state.user)}<div><div class="user-name">${escapeHTML(state.user?.name)}</div><div class="user-kind">${publicMode?'Your account':'Project member'}</div></div></div><button class="sign-out" id="sign-out">Switch account / sign out</button></div></div></aside>`;
}

function bindWorkspaceActions() {
  $$('[data-project]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.project!==state.project?.id)switchProject(button.dataset.project);}));
  $('#sign-out').addEventListener('click',logout);
  $$('[data-create-project]').forEach(button=>button.addEventListener('click',()=>openProjectForm()));
  $$('[data-join-project]').forEach(button=>button.addEventListener('click',openJoinProject));
  $('#connect-mac')?.addEventListener('click',openMacConnection);
}

function renderShell() {
  const project=state.project,publicMode=state.mode==='public';
  if(!project){
    app.innerHTML=`<div class="shell">${sidebarMarkup()}<main class="main"><header class="topbar"><div class="breadcrumb">Your workspace</div><span class="badge">Early access</span></header><div class="onboarding"><div class="eyebrow">A SHARED PICTURE STARTS HERE</div><h1>Bring your team into context.</h1><p>Create a private home for your project's work, decisions, and next steps. Or join a teammate's project with their invite code.</p><div class="onboarding-options"><button class="onboarding-card" data-create-project><span class="onboarding-icon" aria-hidden="true">＋</span><h2>Start a project</h2><p>Set the goal. Capture the work.<br>Keep everyone caught up.</p><strong>Create project <span aria-hidden="true">→</span></strong></button><button class="onboarding-card" data-join-project><span class="onboarding-icon" aria-hidden="true">↗</span><h2>Join your team</h2><p>Have an invite code?<br>Your shared history is waiting.</p><strong>Join a project <span aria-hidden="true">→</span></strong></button></div><p class="helper">Only project members can see its captures and conversations.</p></div></main></div>`;
    bindWorkspaceActions();return;
  }
  const team=publicMode?`<span id="team-count">${Number.isInteger(project.member_count)?`${project.member_count} ${project.member_count===1?'member':'members'}`:''}</span>`:project.id==='proj_cmdshift3'?'<div class="stack">'+avatar({name:'May'})+avatar({name:'Gary'})+'</div><span>2 teammates</span>':avatar(state.user);
  app.innerHTML=`<div class="shell">${sidebarMarkup()}<main class="main"><header class="topbar"><div class="breadcrumb">Workspace <span aria-hidden="true" style="margin:0 10px">/</span><strong id="project-breadcrumb">${escapeHTML(project.name)}</strong></div><div class="connection" id="connection"><span class="connection-dot" aria-hidden="true"></span><span>Connecting…</span></div></header><div class="workspace"><div class="project-heading"><div><div class="eyebrow" style="margin-bottom:5px">THE SHARED PICTURE</div><h1 id="project-name">${escapeHTML(project.name)}</h1><p id="project-description">${escapeHTML(project.description||'Every meaningful change, with the context behind it.')}</p></div><div class="row"><div class="team row">${team}</div><button class="button accent" id="new-commit"><span aria-hidden="true">＋</span> New commit</button></div></div>${publicMode?'<section id="project-context" aria-label="Project context"></section>':''}<div id="project-error"></div><div class="workspace-grid"><section aria-labelledby="feed-title"><div class="feed-head"><h2 id="feed-title"><span id="work-view-title">Work history</span> <span class="feed-count" id="feed-count"></span></h2><div class="work-view-switch" role="group" aria-label="Project view"><button data-work-view="feed" aria-pressed="true">Feed</button><button data-work-view="tree" aria-pressed="false">Progress tree</button></div></div><div class="feed-list" id="feed-list"><div class="loading">Loading your project…</div></div></section><aside class="state-column" aria-label="Current project state"><div id="state-box"></div><div id="catchup-box"></div><div class="provider-note"><span class="status-symbol" aria-hidden="true"></span><span id="provider-note">Confirmed work updates the project state. Catch-up follows the evidence behind your team's updates.</span></div></aside></div></div></main></div>`;
  bindWorkspaceActions();$('#new-commit').addEventListener('click',openComposer);
  $$('[data-work-view]').forEach(button=>button.addEventListener('click',()=>{state.workView=button.dataset.workView;renderProject();}));
  renderProject();renderContextCard();
}

function projectOwnerId(project=state.project) {return project?.owner_id||project?.owner?.id;}
function ownsProject(project=state.project) {return Boolean(state.user&&projectOwnerId(project)===state.user.id);}
function projectVersion(project=state.project) {return project?.version??project?.context_version??1;}
function deadlineLabel(value) {
  if(!value)return 'Not set';
  // Date-only deadlines have no timezone and must not shift to the previous day.
  const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date=match?new Date(Number(match[1]),Number(match[2])-1,Number(match[3])):new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):String(value);
}

function applyProjectMetadata(project) {
  const index=state.projects.findIndex(item=>item.id===project.id);
  if(index!==-1)state.projects[index]={...state.projects[index],...project};
  if(state.project?.id!==project.id)return;
  state.project={...state.project,...project};
  const name=$('#project-name'),description=$('#project-description'),breadcrumb=$('#project-breadcrumb');
  if(name)name.textContent=state.project.name;
  if(description)description.textContent=state.project.description||'Every meaningful change, with the context behind it.';
  if(breadcrumb)breadcrumb.textContent=state.project.name;
  const nav=$$('[data-project]').find(button=>button.dataset.project===project.id);
  if(nav)nav.innerHTML=`<span class="project-dot" aria-hidden="true"></span>${escapeHTML(state.project.name)}`;
  const count=$('#team-count');
  if(count&&Number.isInteger(state.project.member_count))count.textContent=`${state.project.member_count} ${state.project.member_count===1?'member':'members'}`;
  if(state.workView==='tree'&&!state.loading)renderProgressTree();
}

async function loadProjectContext(epoch=state.epoch) {
  if(state.mode!=='public'||!state.project||epoch!==state.epoch)return;
  const projectId=state.project.id,request=++state.contextRequest;
  try{
    const result=await api(`/api/projects/${encodeURIComponent(projectId)}/context`);
    if(epoch!==state.epoch||projectId!==state.project?.id||request!==state.contextRequest)return;
    state.context=result;state.contextError='';applyProjectMetadata(result.project);renderContextCard();
    return result;
  }catch(error){
    if(epoch!==state.epoch||request!==state.contextRequest)return;
    state.contextError=errorText(error);renderContextCard();
  }
}

function renderContextCard() {
  const node=$('#project-context');if(!node||!state.project)return;
  const project=state.project,members=state.context?.members||[],history=state.context?.history||[];
  const owner=members.find(member=>member.id===projectOwnerId(project))||project.owner;
  const count=Number.isInteger(project.member_count)?project.member_count:state.context?members.length:null;
  node.innerHTML=`<article class="context-card"><div class="context-card-head"><div><div class="eyebrow">PROJECT CONTEXT</div><p class="context-subtitle">The goal behind the work.</p></div><div class="row">${ownsProject()?'<button class="button secondary small" id="invite-team">Invite team <span aria-hidden="true">↗</span></button><button class="context-link" id="edit-context">Edit</button>':''}<button class="context-link" id="expand-context" aria-expanded="${state.contextExpanded}">${state.contextExpanded?'Less ↑':'Details ↓'}</button></div></div><div class="context-meta"><div><span>Owner</span><strong>${escapeHTML(owner?.name||(!state.context?'Loading…':'Not recorded'))}</strong></div><div><span>Team</span><strong>${count===null?'Loading…':`${count} ${count===1?'member':'members'}`}</strong></div><div><span>Phase</span><strong>${escapeHTML(project.phase||'Not set')}</strong></div><div><span>Deadline</span><strong>${escapeHTML(deadlineLabel(project.deadline))}</strong></div></div><p class="context-preview">${escapeHTML(project.context||'Add a shared goal, scope, and success criteria so everyone understands the work.')}</p>${state.contextError?`<div class="context-error form-error">${escapeHTML(state.contextError)} <button class="context-link" id="retry-context">Retry</button></div>`:''}${state.contextExpanded?`<div class="context-expanded"><section><h3>The team</h3><div class="context-members">${members.length?members.map(member=>`<span class="context-member">${avatar(member)}${escapeHTML(member.name)}${member.id===projectOwnerId(project)?'<small>Owner</small>':''}</span>`).join(''):'<span class="helper">Loading project members…</span>'}</div></section><section><h3>Context history <span class="helper">Human-confirmed versions</span></h3><div class="context-history">${history.length?[...history].sort((a,b)=>b.version-a.version).map(item=>`<details><summary><span>Version ${Number(item.version)}</span><span>${escapeHTML(item.updated_by?.name||'Project owner')} · ${escapeHTML(fullTime(item.updated_at))}</span></summary><div><strong>${escapeHTML(item.name)}</strong>${item.description?`<p>${escapeHTML(item.description)}</p>`:''}<p>${escapeHTML(item.context||'No background recorded.')}</p><small>Phase: ${escapeHTML(item.phase||'Not set')} · Deadline: ${escapeHTML(deadlineLabel(item.deadline))}</small></div></details>`).join(''):'<p class="helper">No context history available yet.</p>'}</div></section><p class="helper">Progress is derived from confirmed Work Commits below. The project goal and background change when its owner confirms an edit.</p></div>`:''}<div class="context-card-foot"><span>${project.updated_at?`Updated ${escapeHTML(relativeTime(project.updated_at))}`:'Shared project background'}</span><span>Version ${Number(projectVersion(project))}</span></div></article>`;
  $('#expand-context').addEventListener('click',()=>{state.contextExpanded=!state.contextExpanded;renderContextCard();});
  $('#retry-context')?.addEventListener('click',()=>loadProjectContext());
  $('#edit-context')?.addEventListener('click',()=>openProjectForm(state.project));
  $('#invite-team')?.addEventListener('click',openProjectInvite);
}

function openWorkspaceDialog(title,body,footer='') {
  const dialog=$('#workspace-dialog');
  dialog.classList.remove('conversation-dialog');
  const dialogEpoch=++state.workspaceDialogEpoch;
  dialog.innerHTML=`<div class="dialog-header"><h2 id="workspace-dialog-title">${escapeHTML(title)}</h2><button class="icon-button" data-close aria-label="Close ${escapeHTML(title)}">×</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  bindDialogClose(dialog);if(!dialog.open)dialog.showModal();
  return {epoch:state.epoch,dialogEpoch,projectId:state.project?.id};
}
function workspaceDialogCurrent(ticket) {
  return ticket.epoch===state.epoch&&ticket.dialogEpoch===state.workspaceDialogEpoch&&$('#workspace-dialog').open;
}
function projectFormFields(project={}) {
  return `<div class="project-form-fields"><div class="form-field"><label for="project-form-name">Project name</label><input id="project-form-name" name="name" value="${escapeHTML(project.name)}" maxlength="120" required placeholder="What are you working on?"></div><div class="form-field"><label for="project-form-description">One-line description <span class="optional">Optional</span></label><input id="project-form-description" name="description" value="${escapeHTML(project.description)}" maxlength="500" placeholder="A little context at a glance"></div><div class="form-field"><label for="project-form-context">Goal and background <span class="optional">Optional</span></label><textarea id="project-form-context" name="context" maxlength="10000" rows="5" placeholder="Why this project exists, what is in scope, and what success looks like…">${escapeHTML(project.context)}</textarea></div><div class="project-form-meta"><div class="form-field"><label for="project-form-phase">Phase <span class="optional">Optional</span></label><input id="project-form-phase" name="phase" value="${escapeHTML(project.phase)}" maxlength="80" placeholder="e.g. Building"></div><div class="form-field"><label for="project-form-deadline">Deadline <span class="optional">Optional</span></label><input id="project-form-deadline" name="deadline" type="date" value="${escapeHTML(String(project.deadline||'').slice(0,10))}"></div></div></div>`;
}
function readProjectForm() {
  return Object.fromEntries(['name','description','context','phase','deadline'].map(name=>[name,$(`#project-form-${name}`).value.trim()]));
}

function openProjectForm(project=null) {
  const editing=Boolean(project),projectId=project?.id;
  let expectedVersion=projectVersion(project);
  const ticket=openWorkspaceDialog(editing?'Edit project context':'Create a project',`<p class="project-dialog-intro">${editing?'Keep the goal and constraints clear. Each saved edit becomes a new context version.':'Give your team a shared goal. You can add details and invite teammates after creating it.'}</p><form id="project-form">${projectFormFields(project||{})}<div id="project-conflict"></div><p class="form-error" id="workspace-error" role="alert"></p><button class="button accent" id="project-form-submit" type="submit">${editing?'Save context':'Create project'} <span aria-hidden="true">↗</span></button></form>`);
  $('#project-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!workspaceDialogCurrent(ticket))return;
    const body=readProjectForm(),button=$('#project-form-submit');
    if(editing)body.expected_version=expectedVersion;
    button.disabled=true;button.textContent=editing?'Saving…':'Creating…';$('#workspace-error').textContent='';
    let conflict=false;
    try{
      const result=await api(editing?`/api/projects/${encodeURIComponent(projectId)}/context`:'/api/projects',{method:'POST',body});
      if(!workspaceDialogCurrent(ticket))return;
      if(editing){
        applyProjectMetadata(result.project);$('#workspace-dialog').close();renderContextCard();loadProjectContext(ticket.epoch);toast('Project context saved.');
      }else{
        state.projects.push(result.project);$('#workspace-dialog').close();await switchProject(result.project.id);toast('Your project is ready. Invite your team when you are.');
      }
    }catch(error){
      if(!workspaceDialogCurrent(ticket))return;
      $('#workspace-error').textContent=errorText(error);
      if(editing&&error.status===409){
        conflict=true;button.textContent='Review the latest version first';
        const loadLatest=async()=>{
          try{
            const latest=await api(`/api/projects/${encodeURIComponent(projectId)}/context`);
            if(!workspaceDialogCurrent(ticket))return;
            const current=latest.project;
            $('#project-conflict').innerHTML=`<div class="context-conflict"><h3>Your edits are kept.</h3><p>Another context version was saved. Review version ${Number(projectVersion(current))} before saving your changes.</p><details open><summary>Latest project context</summary><strong>${escapeHTML(current.name)}</strong><p>${escapeHTML(current.description)}</p><p>${escapeHTML(current.context||'No background recorded.')}</p><small>Phase: ${escapeHTML(current.phase||'Not set')} · Deadline: ${escapeHTML(deadlineLabel(current.deadline))}</small></details><button type="button" class="button secondary small" id="acknowledge-context">I reviewed it — keep my edits</button></div>`;
            $('#acknowledge-context').addEventListener('click',()=>{expectedVersion=projectVersion(current);$('#project-conflict').innerHTML='';$('#workspace-error').textContent='';button.disabled=false;button.textContent='Save context ↗';});
          }catch(latestError){
            if(!workspaceDialogCurrent(ticket))return;
            $('#project-conflict').innerHTML='<button type="button" class="button secondary small" id="reload-latest-context">Load latest context</button>';
            $('#workspace-error').textContent=errorText(latestError);$('#reload-latest-context').addEventListener('click',loadLatest);
          }
        };
        await loadLatest();
      }
    }finally{
      if(workspaceDialogCurrent(ticket)&&!conflict){button.disabled=false;button.textContent=editing?'Save context ↗':'Create project ↗';}
    }
  });
  $('#project-form-name').focus();
}

function openJoinProject() {
  const ticket=openWorkspaceDialog('Join your team','<p class="project-dialog-intro">Ask the project owner for an invite code. You will be able to see the project history and share your own work.</p><form id="join-project-form"><div class="form-field"><label for="project-invite-code">Project invite code</label><input id="project-invite-code" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="Paste the code your teammate shared"></div><p class="form-error" id="workspace-error" role="alert"></p><button class="button accent" id="join-project-submit" type="submit">Join project <span aria-hidden="true">↗</span></button></form>');
  $('#join-project-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('#join-project-submit');button.disabled=true;button.textContent='Joining…';$('#workspace-error').textContent='';
    try{
      const {project}=await api('/api/projects/join',{method:'POST',body:{code:$('#project-invite-code').value.trim()}});
      if(!workspaceDialogCurrent(ticket))return;
      const index=state.projects.findIndex(item=>item.id===project.id);if(index===-1)state.projects.push(project);else state.projects[index]=project;
      $('#workspace-dialog').close();await switchProject(project.id);toast('You joined the project. Welcome to the shared picture.');
    }catch(error){if(workspaceDialogCurrent(ticket)){$('#workspace-error').textContent=errorText(error);button.disabled=false;button.textContent='Join project ↗';}}
  });
  $('#project-invite-code').focus();
}

function bindCopyButton(button,readValue) {
  button?.addEventListener('click',async()=>{
    const value=readValue();if(!value)return;
    try{await navigator.clipboard.writeText(value);toast('Copied.');}
    catch{toast('Copy is unavailable here. Select the value and copy it.');}
  });
}

function openProjectInvite() {
  if(!ownsProject())return;
  const projectId=state.project.id;
  const ticket=openWorkspaceDialog('Invite your team',`<p class="project-dialog-intro">Invite teammates to ${escapeHTML(state.project.name)}. Anyone with the invite code can join this project after creating an account.</p><div id="invite-result"></div><p class="form-error" id="workspace-error" role="alert"></p><button class="button accent" id="generate-invite">Create invite code <span aria-hidden="true">↗</span></button>`);
  $('#generate-invite').addEventListener('click',async()=>{
    const button=$('#generate-invite');button.disabled=true;button.textContent='Creating…';$('#workspace-error').textContent='';
    try{
      const result=await api(`/api/projects/${encodeURIComponent(projectId)}/invite`,{method:'POST'});
      if(!workspaceDialogCurrent(ticket))return;
      $('#invite-result').innerHTML=`<div class="secret-result"><label for="generated-invite-code">Project invite code</label><div class="secret-row"><input id="generated-invite-code" readonly autocomplete="off" spellcheck="false" value="${escapeHTML(result.invite_code)}"><button class="button secondary small" id="copy-invite">Copy</button></div><p>Expires ${escapeHTML(fullTime(result.expires_at))}. Share it directly with your teammates.</p><p class="helper">Sign up at ${escapeHTML(location.origin)}, then choose “Join with invite.”</p></div>`;
      bindCopyButton($('#copy-invite'),()=>$('#generated-invite-code')?.value);button.textContent='Create another invite';button.disabled=false;
    }catch(error){if(workspaceDialogCurrent(ticket)){$('#workspace-error').textContent=errorText(error);button.disabled=false;button.textContent='Create invite code ↗';}}
  });
}

function openMacConnection() {
  const ticket=openWorkspaceDialog('Connect your Mac',`<p class="project-dialog-intro">Capture, annotate, and commit without leaving your work. Download the app, then connect it to your account.</p><ol class="mac-connect-steps"><li><a href="/downloads/CmdShift3.zip">Download CmdShift3 for Mac</a><span>Apple Silicon · macOS 15 or later</span></li><li>Open the app and enter this server address.<div class="secret-row"><input id="mac-server-address" aria-label="Mac server address" readonly value="${escapeHTML(location.origin)}"><button class="button secondary small" id="copy-mac-server">Copy</button></div></li><li>Create your personal access code below and use it to sign in.</li></ol><div id="mac-code-result"></div><p class="signup-note">Creating a new code replaces your previous Mac sign-in code. Keep this code private; it signs in to your account.</p><p class="form-error" id="workspace-error" role="alert"></p><button class="button accent" id="generate-mac-code">Create personal Mac code <span aria-hidden="true">↗</span></button>`);
  bindCopyButton($('#copy-mac-server'),()=>$('#mac-server-address')?.value);
  $('#generate-mac-code').addEventListener('click',async()=>{
    const button=$('#generate-mac-code');button.disabled=true;button.textContent='Creating…';$('#workspace-error').textContent='';
    try{
      const result=await api('/api/me/access-code',{method:'POST'});
      if(!workspaceDialogCurrent(ticket))return;
      $('#mac-code-result').innerHTML=`<div class="secret-result"><label for="personal-mac-code">Personal Mac access code</label><div class="secret-row"><input id="personal-mac-code" readonly autocomplete="off" spellcheck="false" value="${escapeHTML(result.code)}"><button class="button secondary small" id="copy-mac-code">Copy</button></div><p>Paste it into the Mac app's sign-in form. It is shown here only while this panel is open.</p></div>`;
      bindCopyButton($('#copy-mac-code'),()=>$('#personal-mac-code')?.value);button.disabled=false;button.textContent='Replace personal Mac code';
    }catch(error){if(workspaceDialogCurrent(ticket)){$('#workspace-error').textContent=errorText(error);button.disabled=false;button.textContent='Create personal Mac code ↗';}}
  });
}

// Task links come only from confirmed item identities and explicit shipped.resolves.
function progressTreeData(commits, projectId, currentUserId, members = []) {
  const records = commits.filter(commit=>commit.project_id===projectId).slice().sort((a,b)=>a.sequence-b.sequence);
  const tasks=[], taskById=new Map(), supporting=[], contributors=new Map();
  for(const member of members)if(member.id)contributors.set(member.id,{id:member.id,name:member.name||'Project member'});
  const evidence=(commit,item,role)=>({
    commit_id:commit.id,item_id:item?.id||null,text:item?.text||commit.summary||commit.comment||'Work commit',
    summary:commit.summary||commit.comment||'Work commit',role,author:commit.author,
    git_sha:commit.git?.sha||'',remote_synced:Boolean(commit.git?.remote_synced),created_at:commit.created_at,
    source_app:commit.source?.app_name||'Capture',mine:commit.author?.id===currentUserId,
  });
  for(const commit of records){
    if(commit.author?.id)contributors.set(commit.author.id,{id:commit.author.id,name:commit.author.name||'Project member'});
    const fields=commit.fields||{};
    for(const kind of ['blocker','next'])for(const item of fields[kind]||[]){
      const task={id:item.id,text:item.text,kind,status:kind==='blocker'?'blocked':'open',recorded_by:commit.author,sequence:commit.sequence,evidence:[evidence(commit,item,'Task recorded')]};
      tasks.push(task);taskById.set(item.id,task);
    }
    for(const item of fields.shipped||[]){
      const targets=[...new Set(item.resolves||[])].map(id=>taskById.get(id)).filter(task=>task&&task.sequence<commit.sequence);
      if(targets.length){
        for(const task of targets){task.status='completed';task.evidence.push(evidence(commit,item,'Completed work'));}
      }else{
        tasks.push({id:item.id,text:item.text,kind:'shipped',status:'completed',recorded_by:commit.author,sequence:commit.sequence,evidence:[evidence(commit,item,'Shipped work')]});
      }
    }
    const facts=['decision','why'].flatMap(kind=>(fields[kind]||[]).map(item=>({kind,text:item.text})));
    const hasTaskItems=['blocker','next','shipped'].some(kind=>fields[kind]?.length);
    if(facts.length||!hasTaskItems)supporting.push({...evidence(commit,null,'Supporting record'),facts});
  }
  return {
    tasks:tasks.sort((a,b)=>({blocked:0,open:1,completed:2}[a.status]-{blocked:0,open:1,completed:2}[b.status])||b.sequence-a.sequence),
    supporting:supporting.reverse(),members:[...contributors.values()].sort((a,b)=>a.id.localeCompare(b.id)),
    commit_count:records.length,mine_count:records.filter(commit=>commit.author?.id===currentUserId).length,
  };
}

function progressMemberColors(members, registry) {
  const palette=['#526eab','#ae6945','#6e8753','#9b618d','#477f84','#9e7b32','#856fb0','#b15e6b'];
  const used=new Set(registry.values());
  for(const member of members){
    if(registry.has(member.id))continue;
    let hash=2166136261;
    for(const char of member.id)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
    let color;
    for(let offset=0;offset<palette.length;offset++){
      const candidate=palette[(hash+offset)%palette.length];
      if(!used.has(candidate)){color=candidate;break;}
    }
    if(!color){
      let hue=(hash%3600)/10;
      color=`hsl(${hue} 42% 42%)`;
      while(used.has(color)){hue=(hue+137.5)%360;color=`hsl(${hue} 42% 42%)`;}
    }
    registry.set(member.id,color);used.add(color);
  }
  return registry;
}

function progressEvidenceMarkup(record, colors, highlightMine, supporting = false) {
  const color=colors.get(record.author?.id)||'#777e76';
  return `<li class="progress-evidence ${highlightMine&&record.mine?'my-contribution':''}" style="--member-color:${color}"><button class="progress-evidence-card" data-open-commit="${escapeHTML(record.commit_id)}"><span class="progress-record-top"><span class="progress-author">${escapeHTML(record.author?.name||'Project member')}</span><span class="progress-role">${escapeHTML(record.role)}</span>${record.mine?'<span class="progress-yours">Your contribution</span>':''}</span><span class="progress-record-text">${escapeHTML(record.text)}</span>${supporting&&record.facts.length?`<span class="progress-facts">${record.facts.map(fact=>`${escapeHTML(FIELD_LABELS[fact.kind])}: ${escapeHTML(fact.text)}`).join(' · ')}</span>`:''}<span class="progress-record-source"><span>${escapeHTML(record.source_app)} · ${escapeHTML(relativeTime(record.created_at))}</span><span class="sha" title="${escapeHTML(record.git_sha)}">${escapeHTML(record.git_sha.slice(0,7))}</span><span>${record.remote_synced?'Origin synced':'Sync pending'}</span><span class="progress-open">View capture ↗</span></span></button></li>`;
}

function renderProgressTree() {
  if(!state.project||!$('#feed-list'))return;
  const tree=progressTreeData(state.commits,state.project.id,state.user?.id,state.context?.members||[]);
  const colors=progressMemberColors(tree.members,state.progressColors);
  const project=state.project;
  const statusLabels={blocked:'Blocked',open:'Up next',completed:'Completed'};
  const counts=Object.fromEntries(['blocked','open','completed'].map(status=>[status,tree.tasks.filter(task=>task.status===status).length]));
  $('#feed-list').innerHTML=`<section class="progress-tree" aria-label="Project tasks and contributions"><div class="progress-tools"><p>Follow each task to the work behind it.</p><label><input type="checkbox" id="highlight-my-work" ${state.highlightMine?'checked':''}> Highlight my work</label></div><div class="progress-root"><div class="eyebrow">SHARED PROJECT</div><h3>${escapeHTML(project.name)}</h3>${project.context||project.description?`<p>${escapeHTML(project.context||project.description)}</p>`:''}<div class="progress-root-meta">${project.phase?`<span>${escapeHTML(project.phase)}</span>`:''}<span>${tree.commit_count} confirmed work ${tree.commit_count===1?'commit':'commits'}</span><span>${tree.mine_count} by you</span></div></div><div class="progress-legend" aria-label="Member colors">${tree.members.map(member=>`<span style="--member-color:${colors.get(member.id)}"><i aria-hidden="true"></i>${escapeHTML(member.name)}${member.id===state.user?.id?' · You':''}</span>`).join('')}</div><div class="progress-overview"><span><i class="progress-status-dot blocked" aria-hidden="true"></i>${counts.blocked} blocked</span><span><i class="progress-status-dot open" aria-hidden="true"></i>${counts.open} up next</span><span><i class="progress-status-dot completed" aria-hidden="true"></i>${counts.completed} completed</span></div><ol class="progress-tasks">${tree.tasks.map(task=>`<li class="progress-task" style="--member-color:${colors.get(task.recorded_by?.id)||'#777e76'}"><details data-progress-task="${escapeHTML(task.id)}" ${state.progressCollapsed.has(task.id)?'':'open'}><summary><span class="progress-task-title">${escapeHTML(task.text)}</span><span class="progress-status ${task.status}">${statusLabels[task.status]}</span><span class="progress-task-byline">${task.kind==='shipped'?'Shipped':'Recorded'} by <span class="progress-author">${escapeHTML(task.recorded_by?.name||'Project member')}</span> · ${task.evidence.length} ${task.evidence.length===1?'record':'records'}</span></summary><ol class="progress-contributions">${task.evidence.map(record=>progressEvidenceMarkup(record,colors,state.highlightMine)).join('')}</ol></details></li>`).join('')}${!tree.tasks.length?'<li class="progress-no-tasks"><p>No tasks recorded yet.</p><small>Confirmed blockers, next steps and shipped work will appear here. Captures remain available below.</small></li>':''}${tree.supporting.length?`<li class="progress-support"><details data-progress-task="supporting" ${state.progressCollapsed.has('supporting')?'':'open'}><summary><span class="progress-task-title">Captures, decisions & context</span><span class="progress-task-byline">${tree.supporting.length} supporting ${tree.supporting.length===1?'record':'records'}</span></summary><ol class="progress-contributions">${tree.supporting.map(record=>progressEvidenceMarkup(record,colors,state.highlightMine,true)).join('')}</ol></details></li>`:''}</ol><p class="progress-footnote">Colors show who contributed. A task becomes completed through shipped work or an explicit resolution.</p></section>`;
  $('#highlight-my-work').addEventListener('change',event=>{state.highlightMine=event.target.checked;renderProgressTree();});
  $$('[data-progress-task]',$('#feed-list')).forEach(details=>details.addEventListener('toggle',()=>{
    if(!details.isConnected)return;
    if(details.open)state.progressCollapsed.delete(details.dataset.progressTask);else state.progressCollapsed.add(details.dataset.progressTask);
  }));
  $$('[data-open-commit]',$('#feed-list')).forEach(button=>button.addEventListener('click',()=>openDetail(button.dataset.openCommit)));
}

function renderProject() {
  if (!state.project || !$('#feed-list')) return;
  $('#project-error').innerHTML = state.error ? `<div class="error-banner" role="alert"><span>${escapeHTML(state.error)}</span><button id="refresh-retry">Retry</button></div>` : '';
  $('#refresh-retry')?.addEventListener('click',() => refreshProject(state.epoch));
  $('#feed-count').textContent = state.commits.length ? `${state.commits.length}` : '';
  $('#work-view-title').textContent=state.workView==='tree'?'Progress tree':'Work history';
  $$('[data-work-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.workView===state.workView)));
  $('#feed-list').classList.toggle('showing-tree',state.workView==='tree');
  if (state.loading) $('#feed-list').innerHTML = '<div class="loading">Loading your project…</div>';
  else if(state.workView==='tree')renderProgressTree();
  else if (!state.commits.length) {
    $('#feed-list').innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">⌘</div><h3>Your first update starts here.</h3><p>Capture something you worked on, add a little context, and share it with your team.</p><button id="first-commit" class="button secondary">Make a work commit</button></div>`;
    $('#first-commit').addEventListener('click',openComposer);
  } else {
    $('#feed-list').innerHTML = state.commits.map(commit => commitCard(commit)).join('');
    $$('[data-open-commit]', $('#feed-list')).forEach(button => button.addEventListener('click',() => openDetail(button.dataset.openCommit)));
    hydrateEvidence($('#feed-list'),state.epoch);
  }
  renderCurrentState(); renderCatchupBox(); updateConnection();
}

function commitCard(commit) {
  const fields = fieldsOf(commit);
  const chips = FIELD_NAMES.filter(name => fields[name]?.length).map(name => `<span class="field-chip ${name}">${FIELD_LABELS[name]}${fields[name].length>1?' · '+fields[name].length:''}</span>`).join('');
  return `<article class="commit-card"><div class="card-top">${avatar(commit.author)}<span class="author-name">${escapeHTML(commit.author?.name)}</span><span class="badge">Work commit</span><time class="card-time" datetime="${escapeHTML(commit.created_at)}" title="${escapeHTML(fullTime(commit.created_at))}">${escapeHTML(relativeTime(commit.created_at))}</time></div><div class="card-content"><button class="commit-summary" data-open-commit="${escapeHTML(commit.id)}">${escapeHTML(summaryOf(commit))}</button>${commit.comment&&commit.comment!==commit.summary?`<p class="commit-comment">${escapeHTML(commit.comment)}</p>`:''}<div class="field-chips">${chips}${hasResolved(commit)?'<span class="field-chip resolved">✓ Resolved earlier work</span>':''}</div></div><button class="evidence-button" data-open-commit="${escapeHTML(commit.id)}" aria-label="View evidence for ${escapeHTML(summaryOf(commit))}"><figure class="evidence-figure" data-evidence="${escapeHTML(commit.id)}"><span class="image-loading">Loading capture…</span></figure></button><div class="card-bottom"><div class="row"><span class="sha" title="${escapeHTML(commit.git?.sha || '')}">${escapeHTML((commit.git?.sha || '').slice(0,7))}</span>${syncBadge(commit)}</div><button data-open-commit="${escapeHTML(commit.id)}">View & discuss <span aria-hidden="true">↗</span></button></div></article>`;
}

function renderCurrentState() {
  const sections = [['blockers','Open blockers','blocker'],['decisions','Decisions','decision'],['next','Up next','next'],['shipped','Recently shipped','shipped']];
  $('#state-box').innerHTML = `<div class="state-box"><h2>Where things stand</h2><p class="intro">Grounded in confirmed work.</p><div class="state-box-inner">${sections.map(([key,label,kind]) => {
    const items = [...(state.projectState[key] || [])].reverse();
    return `<section class="state-section"><div class="state-section-title"><span class="status-symbol ${kind}" aria-hidden="true"></span>${label}<span class="count">${items.length}</span></div>${items.length?items.slice(0,4).map(item => `<button class="state-item" data-state-commit="${escapeHTML(item.commit_id)}">${escapeHTML(item.text)}<small>${escapeHTML(item.author?.name || '')} · ${escapeHTML((item.git_sha || '').slice(0,7))}</small></button>`).join('')+(items.length>4?`<p class="state-empty">+ ${items.length-4} more in project history</p>`:''):`<p class="state-empty">${key==='blockers'?'No open blockers.':key==='shipped'?'The next commit will start the story.':'Nothing recorded yet.'}</p>`}</section>`;
  }).join('')}</div></div>`;
  $$('[data-state-commit]').forEach(button => button.addEventListener('click',() => openDetail(button.dataset.stateCommit)));
}

function renderCatchupBox() {
  const unread = state.catchup?.commits?.length ?? 0;
  $('#catchup-box').innerHTML = `<div class="catchup-box"><div class="row space-between"><h3>Back in the loop.</h3>${unread?`<span class="badge">${unread} new</span>`:''}</div><p>${unread?`${unread} work ${unread===1?'commit has':'commits have'} arrived since you last caught up.`:'See what changed since your last visit, with the evidence behind it.'}</p><div class="catchup-actions"><button class="button secondary" id="catch-me-up">Catch me up <span aria-hidden="true">↗</span></button><button class="button secondary" id="ask-project">Ask project <span aria-hidden="true">↗</span></button></div></div>`;
  $('#catch-me-up').addEventListener('click',openCatchup);
  $('#ask-project').addEventListener('click',openProjectConversation);
}

function resetProjectConversation() {
  state.conversation?.controller?.abort();
  state.conversation=null;
}

function projectConversationCurrent(conversation) {
  return Boolean(conversation&&state.conversation===conversation&&conversation.epoch===state.epoch&&conversation.projectId===state.project?.id&&conversation.userId===state.user?.id&&conversation.token===state.token);
}

function projectConversationHistory(turns, question) {
  const content=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,2000).replace(/[\uD800-\uDBFF]$/,'');
  const history=turns.slice(-3).flatMap(turn=>[{role:'user',content:content(turn.question)},{role:'assistant',content:content(turn.answer)}]);
  while(history.length&&(history.reduce((count,message)=>count+message.content.length,0)>6000||new TextEncoder().encode(JSON.stringify({question,history})).length>16*1024))history.splice(0,2);
  return history.filter(message=>message.content.length);
}

function conversationAnswerNote(analyzer={}) {
  if(analyzer.status==='no_changes')return 'Based on project context · No confirmed work yet.';
  if(analyzer.provider==='manual')return analyzer.status==='ai_unavailable'?'AI is unavailable · Showing confirmed records.':'Based on confirmed records · AI is not connected.';
  return 'AI answer · Based on confirmed project records.';
}

function openProjectConversation() {
  if(!state.project||!state.user||!state.token)return;
  if(!state.conversation||!projectConversationCurrent(state.conversation)){
    resetProjectConversation();
    state.conversation={epoch:state.epoch,projectId:state.project.id,userId:state.user.id,token:state.token,turns:[],draft:'',error:'',busy:false,pendingQuestion:'',request:0,controller:null,ticket:null};
  }
  const conversation=state.conversation;
  conversation.ticket=openWorkspaceDialog('Ask project','');
  $('#workspace-dialog').classList.add('conversation-dialog');
  renderProjectConversation(conversation);
  if(!conversation.busy)$('#project-question')?.focus();
}

function renderProjectConversation(conversation) {
  if(!projectConversationCurrent(conversation)||!conversation.ticket||!workspaceDialogCurrent(conversation.ticket))return;
  const dialog=$('#workspace-dialog');
  const suggestions=['What changed for the team?','What is blocked right now?','What should we do next?'];
  $('.dialog-body',dialog).innerHTML=`<div class="conversation-project"><span class="eyebrow">${escapeHTML(state.project.name)}</span><p>Ask about progress, decisions or what comes next.</p></div><div class="project-conversation" aria-live="polite" aria-busy="${conversation.busy}">${conversation.turns.map(turn=>`<section class="conversation-turn"><div class="conversation-question"><span>You</span><p>${escapeHTML(turn.question)}</p></div><div class="conversation-answer"><span class="conversation-answer-note">${escapeHTML(conversationAnswerNote(turn.analyzer))}</span><p>${escapeHTML(turn.answer)}</p>${turn.evidence?.length?`<div class="conversation-sources" aria-label="Sources for this answer">${turn.evidence.map(evidence=>{const commit=state.commits.find(item=>item.id===evidence.commit_id);return `<button data-question-source="${escapeHTML(evidence.commit_id)}" title="${escapeHTML(evidence.git_sha)}"><span>${escapeHTML(commit?summaryOf(commit):'Open source record')}</span><span class="sha">${escapeHTML(evidence.git_sha.slice(0,7))} ↗</span></button>`;}).join('')}</div>`:''}${turn.coverage?.truncated?'<p class="conversation-coverage">This answer covers a selection of the project history. Some earlier work is outside its review.</p>':''}${turn.through_sequence<state.through||turn.context_version<projectVersion()?'<p class="conversation-coverage">The project has changed since this answer. Ask again for the latest.</p>':''}</div></section>`).join('')}${conversation.busy?`<section class="conversation-turn"><div class="conversation-question"><span>You</span><p>${escapeHTML(conversation.pendingQuestion)}</p></div><div class="conversation-thinking" role="status">Reading the project’s work…</div></section>`:''}${!conversation.turns.length&&!conversation.busy?`<div class="conversation-start"><p>Start with the shared picture.</p><div class="conversation-suggestions">${suggestions.map(question=>`<button data-suggest-question="${escapeHTML(question)}">${escapeHTML(question)} <span aria-hidden="true">↗</span></button>`).join('')}</div></div>`:''}</div><form id="project-question-form" class="project-question-form"><label for="project-question" class="sr-only">Ask a project question</label><textarea id="project-question" rows="2" maxlength="2000" required placeholder="What would you like to know?" ${conversation.busy?'disabled':''}>${escapeHTML(conversation.draft)}</textarea><div class="conversation-form-foot"><span>⌘Return to ask</span><button class="button small" type="submit" ${conversation.busy?'disabled':''}>${conversation.busy?'Reading…':'Ask ↗'}</button></div><p class="form-error" id="project-question-error" role="alert">${escapeHTML(conversation.error)}</p></form><div class="conversation-footer"><p>Answers follow confirmed work and project context. This conversation stays in this tab until you switch projects or sign out.</p>${conversation.turns.length?`<button id="clear-project-conversation" ${conversation.busy?'disabled':''}>Clear conversation</button>`:''}</div>`;
  const input=$('#project-question',dialog);
  input.addEventListener('input',()=>{conversation.draft=input.value;});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();askProjectQuestion(conversation);}});
  $('#project-question-form',dialog).addEventListener('submit',event=>{event.preventDefault();askProjectQuestion(conversation);});
  $$('[data-suggest-question]',dialog).forEach(button=>button.addEventListener('click',()=>{input.value=button.dataset.suggestQuestion;conversation.draft=input.value;input.focus();}));
  $$('[data-question-source]',dialog).forEach(button=>button.addEventListener('click',()=>{dialog.close();openDetail(button.dataset.questionSource);}));
  $('#clear-project-conversation',dialog)?.addEventListener('click',()=>{if(!conversation.busy){conversation.turns=[];conversation.error='';renderProjectConversation(conversation);$('#project-question',dialog).focus();}});
  const transcript=$('.project-conversation',dialog);transcript.scrollTop=transcript.scrollHeight;
}

async function askProjectQuestion(conversation) {
  if(!projectConversationCurrent(conversation)||conversation.busy||!conversation.ticket||!workspaceDialogCurrent(conversation.ticket))return;
  const question=conversation.draft.trim();
  if(!question||question.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(question)){
    conversation.error='Write a readable question of up to 2,000 characters.';renderProjectConversation(conversation);return;
  }
  const history=projectConversationHistory(conversation.turns,question);
  const request=++conversation.request;
  conversation.controller=new AbortController();conversation.busy=true;conversation.error='';conversation.pendingQuestion=question;conversation.draft='';
  renderProjectConversation(conversation);
  try{
    const result=await api(`/api/projects/${encodeURIComponent(conversation.projectId)}/conversation`,{method:'POST',token:conversation.token,signal:conversation.controller.signal,body:{question,history}});
    if(!projectConversationCurrent(conversation)||request!==conversation.request)return;
    if(typeof result.answer!=='string'||!result.answer.trim())throw new Error('The project answer was empty. Please try again.');
    conversation.turns.push({question,answer:result.answer,analyzer:result.analyzer||{provider:'manual'},evidence:(Array.isArray(result.evidence)?result.evidence:[]).filter(item=>typeof item?.commit_id==='string'&&typeof item?.git_sha==='string'),coverage:result.coverage,through_sequence:result.through_sequence,context_version:result.context_version});
    conversation.turns=conversation.turns.slice(-3);
  }catch(error){
    if(!projectConversationCurrent(conversation)||request!==conversation.request)return;
    conversation.draft=question;
    conversation.error=error.status===401?'Your sign-in has expired. Sign out and sign in to continue.':error.status===403?'You no longer have access to this project.':error.status===429?'Project questions are busy right now. Try again shortly.':error.status===404?'Project questions are not available yet. Try again shortly.':'Could not read the project right now. Your question is kept here; try again.';
  }finally{
    if(projectConversationCurrent(conversation)&&request===conversation.request){conversation.busy=false;conversation.pendingQuestion='';conversation.controller=null;renderProjectConversation(conversation);}
  }
}

async function refreshProject(epoch = state.epoch) {
  if (epoch !== state.epoch || !state.project) return;
  if (state.refreshPending) {state.refreshAgain = true; return;}
  state.refreshPending = true;
  const projectId = state.project.id, token = state.token;
  loadProjectContext(epoch);
  const catchupRequest=++state.catchupRequest;
  // History/state stay immediate even when a configured analyzer takes longer.
  api(`/api/projects/${projectId}/catchup`,{token}).then(catchup=>{
    if(epoch!==state.epoch||catchupRequest!==state.catchupRequest)return;
    state.catchup=catchup;renderCatchupBox();
    const note=$('#provider-note');
    if(note)note.textContent=`Confirmed work updates the project state. ${analysisNote(catchup.analyzer)}`;
  }).catch(()=>{});
  try {
    const [feed, projectState] = await Promise.all([
      api(`/api/projects/${projectId}/commits`,{token}),
      api(`/api/projects/${projectId}/state`,{token}),
    ]);
    if (epoch !== state.epoch) return;
    state.commits = feed.commits || []; state.through = feed.through_sequence || 0;
    state.projectState = projectState.state || {};
    state.error = ''; state.loading = false; renderProject();
  } catch (error) {
    if (epoch !== state.epoch) return;
    if (error.status === 401) {await logout();toast('Your session expired. Sign in again.');return;}
    state.error = errorText(error); state.loading = false; renderProject();
  } finally {
    if (epoch === state.epoch) {
      state.refreshPending = false;
      if (state.refreshAgain) {state.refreshAgain = false; refreshProject(epoch);}
    }
  }
}

function updateConnection() {
  const node = $('#connection'); if (!node) return;
  node.classList.toggle('live',state.connected);
  node.innerHTML = `<span class="connection-dot" aria-hidden="true"></span><span>${state.connected?'Live team updates':'Reconnecting…'}</span>`;
}

function delay(ms,signal) {
  return new Promise((resolve,reject) => {
    if (signal.aborted) {reject(new DOMException('Aborted','AbortError'));return;}
    const onAbort = () => {clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
    const timer = setTimeout(() => {signal.removeEventListener('abort',onAbort);resolve();},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}

async function startStream(epoch) {
  const controller = new AbortController(); state.stream = controller;
  const projectId = state.project.id, token = state.token;
  let retryMs = 1200;
  while (!controller.signal.aborted && epoch===state.epoch) {
    try {
      const response = await fetch(`/api/projects/${projectId}/events`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
      if(response.status===401&&epoch===state.epoch){await logout();toast('Your session expired. Sign in again.');return;}
      if (!response.ok || !response.body) throw new Error('Live updates unavailable');
      state.connected = true; updateConnection(); retryMs = 1200;
      // Every reconnect reconciles the feed; missed events cannot leave a stale view.
      refreshProject(epoch);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (!controller.signal.aborted) {
        const {value,done} = await reader.read(); if (done) break;
        buffer = (buffer + decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');
        let split;
        while ((split=buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0,split); buffer = buffer.slice(split+2);
          const eventName = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (eventName==='update' && data && epoch===state.epoch) {
            let event; try {event=JSON.parse(data);} catch {continue;}
            if (event.project_id!==projectId) continue;
            refreshProject(epoch);
            if (event.type==='comment' && state.detailId===event.commit_id && $('#detail-dialog').open) loadComments(event.commit_id,state.detailEpoch);
          }
        }
      }
    } catch (error) {
      if (error.name==='AbortError' || epoch!==state.epoch) return;
    }
    if (epoch!==state.epoch || controller.signal.aborted) return;
    state.connected = false; updateConnection();
    try {await delay(retryMs,controller.signal);} catch {return;}
    retryMs = Math.min(10000,retryMs*1.5);
  }
}

function clearImages() {
  for (const entry of state.images.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  state.images.clear();
}

async function evidenceURL(commit,epoch) {
  if (state.images.has(commit.id)) return state.images.get(commit.id).promise;
  const entry = {url:null,promise:null};
  entry.promise = (async () => {
    const response = await fetch(commit.evidence?.image_url || `/api/evidence/${encodeURIComponent(commit.id)}`,{headers:{Authorization:`Bearer ${state.token}`}});
    if (!response.ok) throw new Error('Capture could not be loaded.');
    const blob = await response.blob();
    if (epoch!==state.epoch) throw new DOMException('Project changed','AbortError');
    entry.url = URL.createObjectURL(blob); return entry.url;
  })();
  state.images.set(commit.id,entry);
  try {return await entry.promise;} catch(error) {if (state.images.get(commit.id)===entry) state.images.delete(commit.id);throw error;}
}

function annotationMarkup(annotations, unique='overlay') {
  const marker = `arrow-${unique.replace(/[^a-zA-Z0-9_-]/g,'')}`;
  const shapes = (annotations || []).map(annotation => {
    const x=Number(annotation.x)*1000,y=Number(annotation.y)*1000,w=Number(annotation.w || 0)*1000,h=Number(annotation.h || 0)*1000;
    if (![x,y,w,h].every(Number.isFinite)) return '';
    const color=/^#[0-9a-f]{6}$/i.test(annotation.color || '')?annotation.color:'#db5039';
    if (annotation.type==='arrow') return `<line x1="${x}" y1="${y}" x2="${x+w}" y2="${y+h}" stroke="${color}" stroke-width="4" vector-effect="non-scaling-stroke" marker-end="url(#${marker})"/>`;
    if (annotation.type==='text') return `<text x="${x}" y="${y}" fill="${color}" font-size="32" font-weight="600" font-family="-apple-system,sans-serif" dominant-baseline="hanging" paint-order="stroke" stroke="#fffefa" stroke-width="4">${escapeHTML(annotation.text || '')}</text>`;
    if (annotation.type==='highlight') return `<rect x="${x}" y="${y}" width="${Math.max(0,w)}" height="${Math.max(0,h)}" fill="${color}" opacity=".22"/>`;
    return `<rect x="${x}" y="${y}" width="${Math.max(0,w)}" height="${Math.max(0,h)}" rx="3" fill="none" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#db5039"/></marker></defs>${shapes}`;
}

async function hydrateEvidence(scope,epoch) {
  for (const figure of $$('[data-evidence]',scope)) {
    const id=figure.dataset.evidence;
    const commit=state.commits.find(item=>item.id===id) || figure._commit;
    if (!commit) continue;
    evidenceURL(commit,epoch).then(url => {
      if (epoch!==state.epoch || !figure.isConnected) return;
      const img = new Image(); img.alt = `Capture shared by ${commit.author?.name || 'a teammate'}: ${summaryOf(commit)}`;
      img.onload = () => {
        if (epoch!==state.epoch || !figure.isConnected) return;
        const inner = document.createElement('span'); inner.className='image-inner';inner.append(img);
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.classList.add('annotation-overlay');svg.innerHTML=annotationMarkup(commit.evidence?.annotations,id+Math.random().toString(36).slice(2));inner.append(svg);
        figure.replaceChildren(inner);
      };
      img.onerror = () => {if(figure.isConnected) figure.innerHTML='<span class="image-loading">Capture unavailable.</span>';};
      img.src=url;
    }).catch(error => {if(error.name!=='AbortError'&&figure.isConnected) figure.innerHTML='<span class="image-loading">Capture could not be loaded. Reopen this update to retry.</span>';});
  }
}

function bindDialogClose(dialog) {
  $('[data-close]',dialog)?.addEventListener('click',() => dialog.close());
  dialog.onclick = event => {if(event.target===dialog){if(dialog.id==='composer-dialog'&&state.composer?.busy)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) dialog.close();}};
}

async function openDetail(id) {
  const dialog = $('#detail-dialog');
  state.detailId=id; const detailEpoch=++state.detailEpoch, epoch=state.epoch;
  dialog.innerHTML=`<div class="dialog-header"><h2 id="detail-title">Work commit</h2><button data-close class="icon-button" aria-label="Close details">×</button></div><div class="dialog-body loading">Loading this update…</div>`;
  bindDialogClose(dialog); if(!dialog.open) dialog.showModal();
  try {
    let commit=state.commits.find(item=>item.id===id);
    if(!commit) commit=(await api(`/api/commits/${encodeURIComponent(id)}`)).commit;
    if(epoch!==state.epoch||detailEpoch!==state.detailEpoch||!dialog.open) return;
    renderDetail(commit,dialog,detailEpoch); loadComments(id,detailEpoch);
  } catch(error) {
    if(detailEpoch===state.detailEpoch&&dialog.open) $('.dialog-body',dialog).innerHTML=`<p class="form-error" role="alert">${escapeHTML(errorText(error))}</p>`;
  }
}

function renderDetail(commit,dialog,detailEpoch) {
  const fields=fieldsOf(commit);
  dialog.innerHTML=`<div class="dialog-header"><h2 id="detail-title">Work commit</h2><button data-close class="icon-button" aria-label="Close details">×</button></div><div class="dialog-body"><div class="detail-meta">${avatar(commit.author)}<strong>${escapeHTML(commit.author?.name)}</strong><span class="muted">${escapeHTML(fullTime(commit.created_at))}</span><span class="grow"></span>${syncBadge(commit)}</div><h3 class="detail-summary">${escapeHTML(summaryOf(commit))}</h3>${commit.comment?`<p class="detail-comment">${escapeHTML(commit.comment)}</p>`:''}<div class="detail-evidence"><figure class="evidence-figure" data-evidence="${escapeHTML(commit.id)}"><span class="image-loading">Loading capture…</span></figure></div><div class="detail-fields">${FIELD_NAMES.filter(name=>fields[name]?.length).map(name=>`<div class="field-group ${name}"><div class="eyebrow">${FIELD_LABELS[name]}</div><ul>${fields[name].map(item=>`<li>${escapeHTML(item.text)}${item.resolves?.length?`<span class="resolved-note">✓ Resolves ${item.resolves.length} earlier ${item.resolves.length===1?'item':'items'}</span>`:''}</li>`).join('')}</ul></div>`).join('')}</div><div class="source-line"><span>${escapeHTML(commit.source?.app_name || 'Upload')}${commit.source?.window_title?' · '+escapeHTML(commit.source.window_title):''}</span><span class="sha" title="${escapeHTML(commit.git?.sha || '')}">Git ${escapeHTML((commit.git?.sha || '').slice(0,12))}</span><span class="badge">Confirmed deliverable</span></div><section class="comments-section"><h3>Team discussion</h3><div class="comment-list" id="comment-list"><p class="helper">Loading comments…</p></div><form class="comment-form" id="comment-form"><label for="comment-body" class="sr-only">Add a comment</label><textarea id="comment-body" placeholder="Add context, ask a question, or share a thought…" required maxlength="4000"></textarea><button class="button small" type="submit">Comment</button></form><p id="comment-error" class="form-error" role="alert" style="margin-top:9px"></p></section></div>`;
  $('[data-evidence]',dialog)._commit=commit;
  bindDialogClose(dialog); hydrateEvidence(dialog,state.epoch);
  $('#comment-form',dialog).addEventListener('submit',async event=>{
    event.preventDefault(); if(state.commentPosting) return;
    const input=$('#comment-body',dialog),body=input.value.trim();if(!body) return;
    const button=$('button[type="submit"]',event.currentTarget);
    state.commentPosting=true;button.disabled=true;button.textContent='Posting…';$('#comment-error').textContent='';
    try {
      await api(`/api/commits/${encodeURIComponent(commit.id)}/comments`,{method:'POST',body:{body}});
      if(detailEpoch===state.detailEpoch&&dialog.open){input.value='';await loadComments(commit.id,detailEpoch);toast('Comment shared with the team.');}
    } catch(error) {if(detailEpoch===state.detailEpoch&&dialog.open) $('#comment-error').textContent=errorText(error);}
    finally {state.commentPosting=false;if(button.isConnected){button.disabled=false;button.textContent='Comment';}}
  });
}

async function loadComments(id,detailEpoch) {
  const request=++state.commentRequest;
  try {
    const result=await api(`/api/commits/${encodeURIComponent(id)}/comments`);
    if(request!==state.commentRequest||detailEpoch!==state.detailEpoch||!$('#detail-dialog').open||!$('#comment-list')) return;
    $('#comment-list').innerHTML=result.comments?.length?result.comments.map(comment=>`<div class="discussion-item">${avatar(comment.author)}<div class="discussion-body"><div class="discussion-byline"><strong>${escapeHTML(comment.author?.name)}</strong><time datetime="${escapeHTML(comment.created_at)}" title="${escapeHTML(fullTime(comment.created_at))}">${escapeHTML(relativeTime(comment.created_at))}</time></div><p>${escapeHTML(comment.body)}</p></div></div>`).join(''):'<p class="helper">No comments yet. Bring your teammate into the conversation.</p>';
  }catch(error){if(request===state.commentRequest&&detailEpoch===state.detailEpoch&&$('#comment-list')) $('#comment-list').innerHTML=`<p class="form-error">${escapeHTML(errorText(error))}</p>`;}
}

function readableSummary(summary) {
  if(typeof summary==='string') return summary;
  if(Array.isArray(summary)) return summary.map(item=>typeof item==='string'?item:item.text||item.summary||'').join('\n');
  if(summary&&typeof summary==='object') return Object.entries(summary).map(([key,value])=>`${key}: ${Array.isArray(value)?value.map(item=>typeof item==='string'?item:item.text||'').join('; '):typeof value==='string'?value:''}`).join('\n');
  return 'Your project is up to date.';
}

function historyRetrievalMarkup(retrieval) {
  if(!retrieval || retrieval.provider!=='keewano' || retrieval.status==='disabled')return '';
  const count=Number.isInteger(retrieval.indexed_commits)?retrieval.indexed_commits:0;
  const recent=Number.isInteger(retrieval.recent_git_commits)?retrieval.recent_git_commits:0;
  const completed=retrieval.status==='completed' && count>0;
  const title=completed?'History organized with Keewano':retrieval.status==='unavailable'?'History is available from Git':'History is still syncing';
  const note=completed?`${count} ${count===1?'commit':'commits'} indexed and checked against this project’s Git history.${recent?` ${recent} additional ${recent===1?'update is':'updates are'} included directly from Git.`:''}`:retrieval.status==='unavailable'?'Indexed history could not be reached. Your latest Git updates are included below.':'Your latest Git updates are included below. Indexed history will join the summary when it is ready.';
  return `<div class="history-retrieval${completed?' ready':''}" role="status"><span class="status-symbol" aria-hidden="true"></span><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(note)}</p></div></div>`;
}

async function openCatchup() {
  const dialog=$('#catchup-dialog'),epoch=state.epoch,projectId=state.project.id;
  dialog.innerHTML='<div class="dialog-header"><h2 id="catchup-title">Catch me up</h2><button class="icon-button" data-close aria-label="Close catch-up">×</button></div><div class="dialog-body loading">Finding what changed…</div>';
  bindDialogClose(dialog);if(!dialog.open)dialog.showModal();
  try {
    const result=await api(`/api/projects/${projectId}/catchup`);
    if(epoch!==state.epoch||!dialog.open)return;
    state.catchup=result;renderCatchupBox();
    const commits=result.commits||[],through=result.through_sequence||0;
    dialog.innerHTML=`<div class="dialog-header"><h2 id="catchup-title">You're back in the loop.</h2><button class="icon-button" data-close aria-label="Close catch-up">×</button></div><div class="dialog-body"><p class="catchup-subtitle">${escapeHTML(state.project.name)} · ${commits.length} ${commits.length===1?'update':'updates'} since you last marked the project seen.</p><div class="catchup-summary">${escapeHTML(readableSummary(result.summary))}</div>${historyRetrievalMarkup(result.retrieval)}${commits.length?`<div class="catchup-evidence"><div class="eyebrow">THE WORK BEHIND THE UPDATE</div>${commits.map(commit=>`<button class="catchup-entry" data-catchup-commit="${escapeHTML(commit.id)}">${avatar(commit.author)}<div><strong>${escapeHTML(summaryOf(commit))}</strong><small>${escapeHTML(commit.author?.name)} · ${escapeHTML(relativeTime(commit.created_at))}</small></div><span class="sha">${escapeHTML((commit.git?.sha || '').slice(0,7))} ↗</span></button>`).join('')}</div>`:''}<p class="catchup-provider">${escapeHTML(analysisNote(result.analyzer))}</p><p class="helper" style="margin-top:5px">Opening catch-up does not mark anything read.</p></div><div class="dialog-footer"><span class="helper" id="seen-help">Only these updates will be marked seen.</span><button class="button secondary" data-close-bottom>Keep unread</button><button class="button accent" id="mark-seen">Mark seen <span aria-hidden="true">✓</span></button></div>`;
    bindDialogClose(dialog);$('[data-close-bottom]',dialog).addEventListener('click',()=>dialog.close());
    $$('[data-catchup-commit]',dialog).forEach(button=>button.addEventListener('click',()=>{dialog.close();openDetail(button.dataset.catchupCommit);}));
    $('#mark-seen').addEventListener('click',async()=>{
      const button=$('#mark-seen');button.disabled=true;button.textContent='Marking…';
      try{
        await api(`/api/projects/${projectId}/seen`,{method:'POST',body:{through_sequence:through}});
        if(epoch!==state.epoch)return;
        dialog.close();toast('You’re caught up. New arrivals will stay unread.');await refreshProject(epoch);
      }catch(error){if(epoch===state.epoch&&dialog.open){$('#seen-help').textContent=errorText(error);button.disabled=false;button.textContent='Retry mark seen';}}
    });
  }catch(error){if(epoch===state.epoch&&dialog.open)$('.dialog-body',dialog).innerHTML=`<p class="form-error" role="alert">${escapeHTML(errorText(error))}</p>`;}
}

function openComposer() {
  const dialog=$('#composer-dialog');
  // Closing and reopening keeps the unfinished work, including the retry identity.
  if(state.composer?.projectId!==state.project.id){if(state.composer?.imageURL)URL.revokeObjectURL(state.composer.imageURL);state.composer=null;}
  if(!state.composer)state.composer={projectId:state.project.id,id:uid('wc'),image:null,imageURL:null,filename:'',annotations:[],tool:'rect',annotationText:'',comment:'',summary:'',fields:Object.fromEntries(FIELD_NAMES.map(name=>[name,[]])),resolveIds:[],busy:false,pendingPayload:null,error:'',organizer:{provider:'manual',status:'not_prepared'}};
  renderComposer();if(!dialog.open)dialog.showModal();
}

function readComposerInputs() {
  const c=state.composer,dialog=$('#composer-dialog');if(!c||!$('#compose-comment',dialog))return;
  c.comment=$('#compose-comment',dialog).value;c.summary=$('#compose-summary',dialog).value;
  c.annotationText=$('#annotation-text',dialog)?.value||c.annotationText;
  for(const name of FIELD_NAMES){
    const lines=$(`[data-field="${name}"]`,dialog)?.value.split('\n').map(line=>line.trim()).filter(Boolean)||[];
    const previous=c.fields[name]||[],used=new Set();
    c.fields[name]=lines.map((text,index)=>{const old=previous.find(item=>item.text===text&&!used.has(item.id))||(!used.has(previous[index]?.id)?previous[index]:null);const id=old?.id||uid('it');used.add(id);return {id,text};});
  }
  c.resolveIds=$$('[data-resolve]:checked',dialog).map(input=>input.dataset.resolve);
}

function renderComposer() {
  const c=state.composer,dialog=$('#composer-dialog');if(!c)return;
  const active=[...(state.projectState.blockers||[]).map(item=>({...item,kind:'Blocker'})),...(state.projectState.next||[]).map(item=>({...item,kind:'Next'}))];
  dialog.innerHTML=`<div class="dialog-header"><div><h2 id="composer-title">Commit a little progress.</h2><p class="helper" style="margin-top:3px">${escapeHTML(state.project.name)} · ${escapeHTML(state.user?.name)}</p></div><button class="icon-button" data-close aria-label="Close composer">×</button></div><div class="dialog-body"><div class="composer-grid"><section class="composer-evidence" aria-label="Capture and annotations">${c.image?`<div class="composer-image" id="annotation-stage"><img id="compose-image" src="${escapeHTML(c.imageURL)}" alt="Your capture, ready to annotate"><svg id="compose-overlay" class="annotation-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="Screenshot annotations">${annotationMarkup(c.annotations,'composer')}</svg></div><div class="annotation-toolbar" role="group" aria-label="Annotation tools">${[['rect','□ Rectangle'],['arrow','↗ Arrow'],['highlight','▰ Highlight'],['text','T Text']].map(([value,label])=>`<button class="tool-button ${c.tool===value?'active':''}" data-tool="${value}" aria-pressed="${c.tool===value}">${label}</button>`).join('')}<span class="grow"></span><button class="tool-button" id="undo-annotation" ${!c.annotations.length?'disabled':''}>Undo</button><button class="tool-button" id="clear-annotations" ${!c.annotations.length?'disabled':''}>Clear</button></div><div class="annotation-text" ${c.tool!=='text'?'hidden':''}><label for="annotation-text">Label</label><input id="annotation-text" value="${escapeHTML(c.annotationText)}" placeholder="Type a label, then click the capture" maxlength="300"></div><p class="helper" id="annotation-hint">${c.tool==='text'?'Type a label above, then click to place it.':'Drag on the capture to annotate it.'} Annotations are optional.</p><div class="image-meta"><span>${escapeHTML(c.filename)} · PNG</span><button id="replace-image">Replace capture</button></div><input type="file" id="image-input" accept="image/png" hidden>`:`<div class="upload-zone"><div class="empty-icon" aria-hidden="true">⌘</div><h3>Bring your work into focus.</h3><p>Upload a PNG screenshot, then mark what matters.<br>Or capture directly with the Mac app.</p><label class="button secondary" for="image-input">Choose a capture <span aria-hidden="true">↗</span></label><input type="file" id="image-input" accept="image/png"><p class="helper" style="margin:14px 0 0">PNG · Up to 8 MB</p></div>`}</section><section class="composer-fields" aria-label="Work deliverable"><div class="form-field"><label for="compose-comment">What changed?</label><textarea id="compose-comment" placeholder="A little context goes a long way…" maxlength="10000">${escapeHTML(c.comment)}</textarea></div><div class="form-field"><label for="compose-summary">Commit title</label><input id="compose-summary" placeholder="One clear line about your work" maxlength="500" value="${escapeHTML(c.summary)}"></div><div class="manual-note">${escapeHTML(organizationNote(c.organizer))}</div><div class="row"><button class="button secondary small" id="organize-draft">Prepare draft</button><span class="helper">Start with your comment.</span></div><div class="draft-heading"><h3>The deliverable</h3><span class="helper">Fill only what changed</span></div><div class="field-editor-grid">${FIELD_NAMES.map(name=>`<div class="form-field"><label for="field-${name}">${FIELD_LABELS[name]}</label><textarea id="field-${name}" data-field="${name}" placeholder="${{shipped:'What is done?',decision:'What did you decide?',why:'What led to it?',blocker:'What is in the way?',next:'What comes next?'}[name]}">${escapeHTML((c.fields[name]||[]).map(item=>item.text).join('\n'))}</textarea></div>`).join('')}</div><p class="helper">One item per line. Empty fields are fine.</p>${active.length?`<div class="resolve-list"><h3>Does this work resolve an earlier item?</h3>${active.map(item=>`<label><input type="checkbox" data-resolve="${escapeHTML(item.id)}" ${c.resolveIds.includes(item.id)?'checked':''}><span>${escapeHTML(item.text)} <span class="helper">· ${item.kind}</span></span></label>`).join('')}<p class="helper">Choose only what your shipped work explicitly resolves.</p></div>`:''}</section></div><div id="compose-error" class="${c.error?'compose-error':''}" role="alert">${escapeHTML(c.error)}</div></div><div class="dialog-footer"><span class="helper" id="submit-note">${c.pendingPayload?'Your work is saved here. Retry uses the same commit identity.':'Your capture, annotations, and deliverable become a real Git commit.'}</span><button class="button secondary" id="save-draft-close">Keep draft</button><button class="button accent" id="submit-commit" ${c.busy?'disabled':''}>${c.pendingPayload?'Retry commit':'Commit work'} <span aria-hidden="true">↗</span></button></div>`;
  bindDialogClose(dialog);
  dialog.onclose=()=>{readComposerInputs();};
  $('#save-draft-close',dialog).addEventListener('click',()=>{readComposerInputs();dialog.close();toast('Draft kept in this tab.');});
  $('#image-input',dialog).addEventListener('change',event=>loadCapture(event.target.files?.[0]));
  $('#replace-image',dialog)?.addEventListener('click',()=>$('#image-input',dialog).click());
  $$('[data-tool]',dialog).forEach(button=>button.addEventListener('click',()=>{readComposerInputs();c.tool=button.dataset.tool;renderComposer();}));
  $('#undo-annotation',dialog)?.addEventListener('click',()=>{readComposerInputs();c.annotations.pop();renderComposer();});
  $('#clear-annotations',dialog)?.addEventListener('click',()=>{readComposerInputs();c.annotations=[];renderComposer();});
  $('#organize-draft',dialog).addEventListener('click',prepareDraft);
  $('#submit-commit',dialog).addEventListener('click',submitCommit);
  if(c.image)bindAnnotationDrawing();
  setComposerBusy(c.busy,Boolean(c.pendingPayload));
}

async function loadCapture(file) {
  if(!file)return;
  const c=state.composer;readComposerInputs();
  if(file.type!=='image/png'&&!file.name.toLowerCase().endsWith('.png')){composerError('Choose a PNG screenshot.');return;}
  if(file.size>8*1024*1024){composerError('This capture is larger than 8 MB. Try a smaller region.');return;}
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes.slice(0,8).join(',')!=='137,80,78,71,13,10,26,10'){composerError('This file is not a valid PNG screenshot.');return;}
    const dataURL=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
    if(state.composer!==c)return;
    if(c.imageURL)URL.revokeObjectURL(c.imageURL);
    c.image=dataURL.split(',')[1];c.imageURL=URL.createObjectURL(file);c.filename=file.name;c.annotations=[];c.error='';
    renderComposer();
  }catch{composerError('This capture could not be opened. Try again.');}
}

function bindAnnotationDrawing() {
  const c=state.composer,overlay=$('#compose-overlay');let start=null,current=null;
  const point=event=>{const rect=overlay.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width)),y:Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height))};};
  const redraw=()=>{overlay.innerHTML=annotationMarkup([...c.annotations,...(current?[current]:[])],'composer');};
  overlay.addEventListener('pointerdown',event=>{
    if(c.busy||c.pendingPayload||event.button!==0)return;
    event.preventDefault();start=point(event);overlay.setPointerCapture(event.pointerId);
    if(c.tool==='text'){
      c.annotationText=$('#annotation-text').value.trim();
      if(!c.annotationText){toast('Type a label first.');start=null;return;}
      c.annotations.push({type:'text',...start,w:0,h:0,text:c.annotationText,color:'#db5039'});start=null;redraw();$('#undo-annotation').disabled=false;$('#clear-annotations').disabled=false;return;
    }
    current={type:c.tool,...start,w:0,h:0,color:c.tool==='highlight'?'#e9b449':'#db5039'};
  });
  overlay.addEventListener('pointermove',event=>{
    if(!start||!current)return;const end=point(event);
    if(c.tool==='arrow')current={...current,x:start.x,y:start.y,w:end.x-start.x,h:end.y-start.y};
    else current={...current,x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),w:Math.abs(end.x-start.x),h:Math.abs(end.y-start.y)};
    redraw();
  });
  const finish=()=>{if(current&&(Math.abs(current.w)>.005||Math.abs(current.h)>.005))c.annotations.push(current);start=null;current=null;redraw();$('#undo-annotation').disabled=!c.annotations.length;$('#clear-annotations').disabled=!c.annotations.length;};
  overlay.addEventListener('pointerup',finish);overlay.addEventListener('pointercancel',()=>{start=null;current=null;redraw();});
}

function composerError(message) {
  if(!state.composer)return;state.composer.error=message;
  const node=$('#compose-error');if(node){node.className=message?'compose-error':'';node.textContent=message;}
}

function setComposerBusy(busy,frozen=false,busyLabel='Committing…') {
  const c=state.composer;if(!c)return;
  $$('input,textarea,button', $('#composer-dialog')).forEach(node=>{
    if(node.matches('[data-close],#save-draft-close'))node.disabled=busy;
    else if(node.id==='submit-commit')node.disabled=busy;
    else node.disabled=busy||frozen;
  });
  const button=$('#submit-commit');if(button)button.textContent=busy?busyLabel:c.pendingPayload?'Retry commit ↗':'Commit work ↗';
}

async function prepareDraft() {
  const c=state.composer;if(!c||c.busy)return;readComposerInputs();
  if(!c.comment.trim()){composerError('Add a little context before preparing the draft.');$('#compose-comment').focus();return;}
  const epoch=state.epoch;c.busy=true;composerError('');setComposerBusy(true,false,'Preparing draft…');
  try{
    const result=await api('/api/draft',{method:'POST',body:{project_id:c.projectId,comment:c.comment,source:{app_name:'Web upload',window_title:c.filename,capture_kind:'upload'},...(c.image?{image_base64:c.image}:{})}});
    if(state.composer!==c||epoch!==state.epoch)return;
    Object.assign(c,draftResultUpdate(c,result));
    c.busy=false;renderComposer();toast(organizationToast(c.organizer));
  }catch(error){if(state.composer===c){c.busy=false;composerError(errorText(error));setComposerBusy(false);}}
}

async function submitCommit() {
  const c=state.composer;if(!c||c.busy)return;
  if(!c.pendingPayload){
    readComposerInputs();
    if(!c.image){composerError('Choose a PNG capture before committing.');return;}
    if(!c.summary.trim()&&!c.comment.trim()){composerError('Give your work a title or a little context.');$('#compose-comment').focus();return;}
    if(c.resolveIds.length&&!c.fields.shipped.length){composerError('Add a shipped item to explain how this work resolves the selected items.');$('#field-shipped').focus();return;}
    const fields=Object.fromEntries(FIELD_NAMES.map(name=>[name,c.fields[name].map(item=>({...item}))]));
    if(c.resolveIds.length)fields.shipped[0].resolves=[...c.resolveIds];
    c.pendingPayload={id:c.id,project_id:c.projectId,source:{app_name:'Web upload',window_title:c.filename,capture_kind:'upload'},image_base64:c.image,annotations:c.annotations,comment:c.comment.trim(),summary:c.summary.trim()||c.comment.trim().split('\n')[0].slice(0,250),fields};
  }
  const epoch=state.epoch;c.busy=true;composerError('');setComposerBusy(true,true);
  $('#submit-note').textContent='Saving your deliverable and syncing the project…';
  try{
    const {commit}=await api('/api/commits',{method:'POST',body:c.pendingPayload});
    if(c.imageURL)URL.revokeObjectURL(c.imageURL);
    if(state.composer===c){state.composer=null;$('#composer-dialog').close();}
    toast(`Committed ${(commit.git?.sha || '').slice(0,7)} · ${commit.git?.remote_synced?'origin synced':'origin sync pending'}`);
    if(epoch===state.epoch){await refreshProject(epoch);openDetail(commit.id);}
  }catch(error){
    if(state.composer!==c)return;c.busy=false;
    // An uncertain network/server result keeps its exact payload and ID for safe retry.
    if(error.status&&error.status<500&&error.status!==409){c.pendingPayload=null;c.id=uid('wc');}
    composerError(errorText(error));setComposerBusy(false,Boolean(c.pendingPayload));
    $('#submit-note').textContent=c.pendingPayload?'Your work is preserved. Retry safely uses the same commit identity.':'Your draft is preserved. Update it and try again.';
  }
}

$('#composer-dialog').addEventListener('cancel',event=>{if(state.composer?.busy){event.preventDefault();return;}readComposerInputs();});
$('#detail-dialog').addEventListener('close',()=>{state.detailId=null;state.detailEpoch++;});
$('#workspace-dialog').addEventListener('close',()=>{if(!$('#workspace-dialog').open){state.workspaceDialogEpoch++;$('#workspace-dialog').innerHTML='';}});
window.addEventListener('beforeunload',()=>{state.stream?.abort();clearImages();if(state.composer?.imageURL)URL.revokeObjectURL(state.composer.imageURL);});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&state.user&&state.project&&!$$('dialog[open]').length){event.preventDefault();openComposer();}});

async function boot() {
  app.innerHTML='<div class="loading" style="min-height:100vh;display:grid;place-items:center">Opening CmdShift3…</div>';
  try{
    const health=await api('/api/health',{token:null});state.mode=health.mode==='public'?'public':'demo';state.publicRegistration=health.public_registration===true;
  }catch{
    app.innerHTML='<main class="startup-error"><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><h1>We could not open the workspace.</h1><p>Check your connection and try again.</p><button class="button accent" id="retry-boot">Try again ↗</button></main>';
    $('#retry-boot').addEventListener('click',boot);return;
  }
  if(!state.token){loginScreen();return;}
  app.innerHTML='<div class="loading" style="min-height:100vh;display:grid;place-items:center">Opening your workspace…</div>';
  try{const me=await api('/api/me');state.user=me.user;state.projects=me.projects||[];await enterWorkspace();}
  catch(error){state.token=null;sessionStorage.removeItem('cmdshift3-token');loginScreen(error.status===401?'Your session expired. Sign in to continue.':errorText(error));}
}
boot();
