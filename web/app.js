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

function loginScreen(message='') {
  app.innerHTML = `<main class="login-screen">
    <section class="login-story"><div><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><h1>Commit your work.<br>Everyone stays<br>caught up.</h1><p>A screenshot. A little context. A shared understanding of what happens next.</p>
    <div class="login-visual" aria-hidden="true"><div class="mini-window"><div class="window-dots"><i></i><i></i><i></i></div><div class="line"></div><div class="line"></div><div class="line" style="width:65%"></div><div class="line" style="width:90%"></div></div><div class="mini-commit"><span style="color:#bdc9b2">✓ Work committed</span><strong>The team is on the same page.</strong><span class="sha">Every update. A real Git commit.</span></div></div></div><p class="tiny">Made for the moments that move a project forward.</p></section>
    <section class="login-form-wrap"><div class="login-panel"><div class="eyebrow" style="margin-bottom:14px">YOUR TEAM, IN CONTEXT</div><h2>Pick up where you left off.</h2><p>Open a project to see the work, the decisions, and what your teammates need next.</p>
    <form id="login-form"><div class="form-field"><label for="invite-code">Demo access code</label><input id="invite-code" name="code" autocomplete="off" placeholder="Enter your access code" required></div><p id="login-error" class="form-error" role="alert">${escapeHTML(message)}</p><button class="button accent" type="submit">Open workspace <span aria-hidden="true">↗</span></button></form>
    <div class="login-options"><div class="eyebrow">TRY THE TEAM DEMO</div><button class="button secondary" data-demo="may-demo">${avatar({name:'May'})}<span>Continue as May</span><span class="grow"></span><span aria-hidden="true">→</span></button><button class="button secondary" data-demo="gary-demo">${avatar({name:'Gary'})}<span>Continue as Gary</span><span class="grow"></span><span aria-hidden="true">→</span></button><p>Use two tabs with different accounts to see shared updates. These are demo sessions, not production accounts.</p></div><p class="login-footnote">Screenshots stay inside the project they belong to.</p></div></section></main>`;
  $('#login-form').addEventListener('submit', event => {event.preventDefault(); login($('#invite-code').value.trim());});
  $$('[data-demo]').forEach(button => button.addEventListener('click', () => login(button.dataset.demo)));
}

async function login(code) {
  if (!code) return;
  $$('button', app).forEach(button => button.disabled = true); $('#login-error').textContent = '';
  try {
    const result = await api('/api/session', {method:'POST',body:{code},token:null});
    state.token = result.token; sessionStorage.setItem('cmdshift3-token', result.token);
    state.user = result.user; state.projects = result.projects || [];
    await enterWorkspace();
  } catch (error) {
    loginScreen(errorText(error));
  }
}

async function logout() {
  const token = state.token;
  state.epoch++; state.stream?.abort(); clearImages();
  state.token = null; state.user = null; sessionStorage.removeItem('cmdshift3-token');
  if(state.composer?.imageURL) URL.revokeObjectURL(state.composer.imageURL);
  state.composer = null;
  sessionStorage.removeItem('cmdshift3-project');
  $$('dialog').forEach(dialog => dialog.close());
  loginScreen();
  if (token) api('/api/session/logout',{method:'POST',token}).catch(() => {});
}

async function enterWorkspace() {
  if (!state.projects.length) state.projects = (await api('/api/projects')).projects || [];
  const saved = sessionStorage.getItem('cmdshift3-project');
  const project = state.projects.find(item => item.id === saved) || state.projects[0];
  if (!project) {loginScreen('This account has no projects.'); return;}
  await switchProject(project.id);
}

async function switchProject(id) {
  const project = state.projects.find(item => item.id === id); if (!project) return;
  state.epoch++; state.stream?.abort(); clearImages();
  state.project = project; state.commits = []; state.catchup = null; state.through = 0;
  state.projectState = {shipped:[],decisions:[],blockers:[],next:[]};
  state.connected = false; state.loading = true; state.error = '';
  state.refreshPending = false; state.refreshAgain = false;
  state.detailId = null; state.detailEpoch++;
  $$('dialog').forEach(dialog => dialog.close());
  sessionStorage.setItem('cmdshift3-project',id); renderShell();
  const epoch = state.epoch;
  await refreshProject(epoch);
  if (epoch === state.epoch && state.token) startStream(epoch);
}

function renderShell() {
  const project = state.project;
  app.innerHTML = `<div class="shell"><aside class="sidebar" aria-label="Workspace navigation"><div class="brand"><span class="brand-mark">⌘</span>CmdShift3</div><p class="tagline">Work, together.</p><div class="eyebrow">YOUR PROJECTS</div><nav class="project-list">${state.projects.map(item => `<button class="project-button ${item.id===project.id?'active':''}" data-project="${escapeHTML(item.id)}" ${item.id===project.id?'aria-current="page"':''}><span class="project-dot" aria-hidden="true"></span>${escapeHTML(item.name)}</button>`).join('')}</nav><div class="sidebar-note">Small updates.<br>A shared project history.</div><div class="sidebar-bottom"><span class="badge">Demo workspace</span><div class="session-card"><div class="row">${avatar(state.user)}<div><div class="user-name">${escapeHTML(state.user?.name)}</div><div class="user-kind">Project member</div></div></div><button class="sign-out" id="sign-out">Switch account / sign out</button></div></div></aside>
    <main class="main"><header class="topbar"><div class="breadcrumb">Workspace <span aria-hidden="true" style="margin:0 10px">/</span><strong>${escapeHTML(project.name)}</strong></div><div class="connection" id="connection"><span class="connection-dot" aria-hidden="true"></span><span>Connecting…</span></div></header><div class="workspace"><div class="project-heading"><div><div class="eyebrow" style="margin-bottom:5px">THE SHARED PICTURE</div><h1>${escapeHTML(project.name)}</h1><p>${escapeHTML(project.description || 'Every meaningful change, with the context behind it.')}</p></div><div class="row"><div class="team row">${project.id==='proj_cmdshift3'?'<div class="stack">'+avatar({name:'May'})+avatar({name:'Gary'})+'</div><span>2 teammates</span>':avatar(state.user)}</div><button class="button accent" id="new-commit"><span aria-hidden="true">＋</span> New commit</button></div></div><div id="project-error"></div><div class="workspace-grid"><section aria-labelledby="feed-title"><div class="feed-head"><h2 id="feed-title">Work history <span class="feed-count" id="feed-count"></span></h2><span class="eyebrow">LATEST FIRST</span></div><div class="feed-list" id="feed-list"><div class="loading">Loading your project…</div></div></section><aside class="state-column" aria-label="Current project state"><div id="state-box"></div><div id="catchup-box"></div><div class="provider-note"><span class="status-symbol" aria-hidden="true"></span><span id="provider-note">Confirmed work updates the project state. AI organization is not connected in this demo.</span></div></aside></div></div></main></div>`;
  $$('[data-project]').forEach(button => button.addEventListener('click',() => {if (button.dataset.project!==state.project.id) switchProject(button.dataset.project);}));
  $('#sign-out').addEventListener('click',logout); $('#new-commit').addEventListener('click',openComposer);
  renderProject();
}

function renderProject() {
  if (!state.project || !$('#feed-list')) return;
  $('#project-error').innerHTML = state.error ? `<div class="error-banner" role="alert"><span>${escapeHTML(state.error)}</span><button id="refresh-retry">Retry</button></div>` : '';
  $('#refresh-retry')?.addEventListener('click',() => refreshProject(state.epoch));
  $('#feed-count').textContent = state.commits.length ? `${state.commits.length}` : '';
  if (state.loading) $('#feed-list').innerHTML = '<div class="loading">Loading your project…</div>';
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
  $('#catchup-box').innerHTML = `<div class="catchup-box"><div class="row space-between"><h3>Back in the loop.</h3>${unread?`<span class="badge">${unread} new</span>`:''}</div><p>${unread?`${unread} work ${unread===1?'commit has':'commits have'} arrived since you last caught up.`:'See what changed since your last visit, with the evidence behind it.'}</p><button class="button secondary" id="catch-me-up">Catch me up <span aria-hidden="true">↗</span></button></div>`;
  $('#catch-me-up').addEventListener('click',openCatchup);
}

async function refreshProject(epoch = state.epoch) {
  if (epoch !== state.epoch) return;
  if (state.refreshPending) {state.refreshAgain = true; return;}
  state.refreshPending = true;
  const projectId = state.project.id, token = state.token;
  const catchupRequest=++state.catchupRequest;
  // History/state stay immediate even when a configured analyzer takes longer.
  api(`/api/projects/${projectId}/catchup`,{token}).then(catchup=>{
    if(epoch!==state.epoch||catchupRequest!==state.catchupRequest)return;
    state.catchup=catchup;renderCatchupBox();
    const note=$('#provider-note');
    if(note)note.textContent=catchup.analyzer?.provider==='manual'?'Confirmed work updates the project state. AI analysis is not connected for this summary.':`Confirmed work updates the project state. Catch-up analysis by ${catchup.analyzer?.provider || 'your configured provider'}.`;
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

async function openCatchup() {
  const dialog=$('#catchup-dialog'),epoch=state.epoch,projectId=state.project.id;
  dialog.innerHTML='<div class="dialog-header"><h2 id="catchup-title">Catch me up</h2><button class="icon-button" data-close aria-label="Close catch-up">×</button></div><div class="dialog-body loading">Finding what changed…</div>';
  bindDialogClose(dialog);if(!dialog.open)dialog.showModal();
  try {
    const result=await api(`/api/projects/${projectId}/catchup`);
    if(epoch!==state.epoch||!dialog.open)return;
    state.catchup=result;renderCatchupBox();
    const commits=result.commits||[],through=result.through_sequence||0;
    const provider=result.analyzer?.provider || 'manual';
    dialog.innerHTML=`<div class="dialog-header"><h2 id="catchup-title">You're back in the loop.</h2><button class="icon-button" data-close aria-label="Close catch-up">×</button></div><div class="dialog-body"><p class="catchup-subtitle">${escapeHTML(state.project.name)} · ${commits.length} ${commits.length===1?'update':'updates'} since you last marked the project seen.</p><div class="catchup-summary">${escapeHTML(readableSummary(result.summary))}</div>${commits.length?`<div class="catchup-evidence"><div class="eyebrow">THE WORK BEHIND THE UPDATE</div>${commits.map(commit=>`<button class="catchup-entry" data-catchup-commit="${escapeHTML(commit.id)}">${avatar(commit.author)}<div><strong>${escapeHTML(summaryOf(commit))}</strong><small>${escapeHTML(commit.author?.name)} · ${escapeHTML(relativeTime(commit.created_at))}</small></div><span class="sha">${escapeHTML((commit.git?.sha || '').slice(0,7))} ↗</span></button>`).join('')}</div>`:''}<p class="catchup-provider">${provider==='manual'?'Based on confirmed deliverables. AI analysis is not connected.':`Analysis by ${escapeHTML(provider)} · ${escapeHTML(result.analyzer?.status || '')}`}</p><p class="helper" style="margin-top:5px">Opening catch-up does not mark anything read.</p></div><div class="dialog-footer"><span class="helper" id="seen-help">Only these updates will be marked seen.</span><button class="button secondary" data-close-bottom>Keep unread</button><button class="button accent" id="mark-seen">Mark seen <span aria-hidden="true">✓</span></button></div>`;
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
  if(!state.composer)state.composer={projectId:state.project.id,id:uid('wc'),image:null,imageURL:null,filename:'',annotations:[],tool:'rect',annotationText:'',comment:'',summary:'',fields:Object.fromEntries(FIELD_NAMES.map(name=>[name,[]])),resolveIds:[],busy:false,pendingPayload:null,error:'',organizer:{provider:'manual',status:'not_connected'}};
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
  dialog.innerHTML=`<div class="dialog-header"><div><h2 id="composer-title">Commit a little progress.</h2><p class="helper" style="margin-top:3px">${escapeHTML(state.project.name)} · ${escapeHTML(state.user?.name)}</p></div><button class="icon-button" data-close aria-label="Close composer">×</button></div><div class="dialog-body"><div class="composer-grid"><section class="composer-evidence" aria-label="Capture and annotations">${c.image?`<div class="composer-image" id="annotation-stage"><img id="compose-image" src="${escapeHTML(c.imageURL)}" alt="Your capture, ready to annotate"><svg id="compose-overlay" class="annotation-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="Screenshot annotations">${annotationMarkup(c.annotations,'composer')}</svg></div><div class="annotation-toolbar" role="group" aria-label="Annotation tools">${[['rect','□ Rectangle'],['arrow','↗ Arrow'],['highlight','▰ Highlight'],['text','T Text']].map(([value,label])=>`<button class="tool-button ${c.tool===value?'active':''}" data-tool="${value}" aria-pressed="${c.tool===value}">${label}</button>`).join('')}<span class="grow"></span><button class="tool-button" id="undo-annotation" ${!c.annotations.length?'disabled':''}>Undo</button><button class="tool-button" id="clear-annotations" ${!c.annotations.length?'disabled':''}>Clear</button></div><div class="annotation-text" ${c.tool!=='text'?'hidden':''}><label for="annotation-text">Label</label><input id="annotation-text" value="${escapeHTML(c.annotationText)}" placeholder="Type a label, then click the capture" maxlength="300"></div><p class="helper" id="annotation-hint">${c.tool==='text'?'Type a label above, then click to place it.':'Drag on the capture to annotate it.'} Annotations are optional.</p><div class="image-meta"><span>${escapeHTML(c.filename)} · PNG</span><button id="replace-image">Replace capture</button></div><input type="file" id="image-input" accept="image/png" hidden>`:`<div class="upload-zone"><div class="empty-icon" aria-hidden="true">⌘</div><h3>Bring your work into focus.</h3><p>Upload a PNG screenshot, then mark what matters.<br>Or capture directly with the Mac app.</p><label class="button secondary" for="image-input">Choose a capture <span aria-hidden="true">↗</span></label><input type="file" id="image-input" accept="image/png"><p class="helper" style="margin:14px 0 0">PNG · Up to 8 MB</p></div>`}</section><section class="composer-fields" aria-label="Work deliverable"><div class="form-field"><label for="compose-comment">What changed?</label><textarea id="compose-comment" placeholder="A little context goes a long way…" maxlength="10000">${escapeHTML(c.comment)}</textarea></div><div class="form-field"><label for="compose-summary">Commit title</label><input id="compose-summary" placeholder="One clear line about your work" maxlength="500" value="${escapeHTML(c.summary)}"></div><div class="manual-note">${c.organizer.provider==='manual'?'Manual organization · AI is not connected. Your words and confirmed fields are the source of truth.':`Organized by ${escapeHTML(c.organizer.provider)} · Review before committing.`}</div><div class="row"><button class="button secondary small" id="organize-draft">Prepare draft</button><span class="helper">Start with your comment.</span></div><div class="draft-heading"><h3>The deliverable</h3><span class="helper">Fill only what changed</span></div><div class="field-editor-grid">${FIELD_NAMES.map(name=>`<div class="form-field"><label for="field-${name}">${FIELD_LABELS[name]}</label><textarea id="field-${name}" data-field="${name}" placeholder="${{shipped:'What is done?',decision:'What did you decide?',why:'What led to it?',blocker:'What is in the way?',next:'What comes next?'}[name]}">${escapeHTML((c.fields[name]||[]).map(item=>item.text).join('\n'))}</textarea></div>`).join('')}</div><p class="helper">One item per line. Empty fields are fine.</p>${active.length?`<div class="resolve-list"><h3>Does this work resolve an earlier item?</h3>${active.map(item=>`<label><input type="checkbox" data-resolve="${escapeHTML(item.id)}" ${c.resolveIds.includes(item.id)?'checked':''}><span>${escapeHTML(item.text)} <span class="helper">· ${item.kind}</span></span></label>`).join('')}<p class="helper">Choose only what your shipped work explicitly resolves.</p></div>`:''}</section></div><div id="compose-error" class="${c.error?'compose-error':''}" role="alert">${escapeHTML(c.error)}</div></div><div class="dialog-footer"><span class="helper" id="submit-note">${c.pendingPayload?'Your work is saved here. Retry uses the same commit identity.':'Your capture, annotations, and deliverable become a real Git commit.'}</span><button class="button secondary" id="save-draft-close">Keep draft</button><button class="button accent" id="submit-commit" ${c.busy?'disabled':''}>${c.pendingPayload?'Retry commit':'Commit work'} <span aria-hidden="true">↗</span></button></div>`;
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

function setComposerBusy(busy,frozen=false) {
  const c=state.composer;if(!c)return;
  $$('input,textarea,button', $('#composer-dialog')).forEach(node=>{
    if(node.matches('[data-close],#save-draft-close'))node.disabled=busy;
    else if(node.id==='submit-commit')node.disabled=busy;
    else node.disabled=busy||frozen;
  });
  const button=$('#submit-commit');if(button)button.textContent=busy?'Committing…':c.pendingPayload?'Retry commit ↗':'Commit work ↗';
}

async function prepareDraft() {
  const c=state.composer;if(!c||c.busy)return;readComposerInputs();
  if(!c.comment.trim()){composerError('Add a little context before preparing the draft.');$('#compose-comment').focus();return;}
  const epoch=state.epoch;c.busy=true;composerError('');setComposerBusy(true);
  try{
    const result=await api('/api/draft',{method:'POST',body:{project_id:c.projectId,comment:c.comment,source:{app_name:'Web upload',window_title:c.filename,capture_kind:'upload'},...(c.image?{image_base64:c.image}:{})}});
    if(state.composer!==c||epoch!==state.epoch)return;
    c.summary=result.summary||c.summary;c.fields=Object.fromEntries(FIELD_NAMES.map(name=>[name,result.fields?.[name]||[]]));c.resolveIds=[...new Set(c.fields.shipped.flatMap(item=>item.resolves||[]))];c.organizer=result.organizer||{provider:'manual',status:'not_connected'};
    c.busy=false;renderComposer();toast(c.organizer.provider==='manual'?'Draft ready. Review and fill in what changed.':'Draft organized. Review it before committing.');
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
window.addEventListener('beforeunload',()=>{state.stream?.abort();clearImages();if(state.composer?.imageURL)URL.revokeObjectURL(state.composer.imageURL);});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&state.user&&!$$('dialog[open]').length){event.preventDefault();openComposer();}});

async function boot() {
  if(!state.token){loginScreen();return;}
  app.innerHTML='<div class="loading" style="min-height:100vh;display:grid;place-items:center">Opening your workspace…</div>';
  try{const me=await api('/api/me');state.user=me.user;state.projects=me.projects||[];await enterWorkspace();}
  catch(error){state.token=null;sessionStorage.removeItem('cmdshift3-token');loginScreen(error.status===401?'Your session expired. Choose an account to continue.':errorText(error));}
}
boot();
