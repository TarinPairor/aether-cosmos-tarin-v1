const $ = id => document.getElementById(id);
let state, selectedId = null, selectedExternal = null, selectedThread = null;
let gmailThreads = [], nextPageToken = null, working = false, offline = false, owner = null;
let listKey = null, historyKey = null, profileKey = null, threadLoadError = '', lastThreadRefresh = null;
const labels = {ready:'Intro ready',waiting:'Waiting for reply',reply_ready:'Reply ready',followup_ready:'Reply ready',sending:'Sending',paused:'Paused',error:'Needs attention',limit_reached:'Five-email limit',complete:'Profile complete',stopped:'Recipient stopped',send_uncertain:'Check Sent',archived:'Earlier thread'};
const current = () => state?.intakes?.find(s => s.id === selectedId);
function notice(text, error = false) { $('notice').hidden = !text; $('notice').textContent = text; $('notice').className = 'notice' + (error ? ' error' : ''); }
async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'The request failed. Try again.'); return result;
}
function acceptSession(session) {
  if (!state.intakes) state.intakes = [];
  const i = state.intakes.findIndex(s => s.id === session.id);
  if (i < 0) state.intakes.unshift(session); else state.intakes[i] = session;
}
function renderList() {
  const sessions = (state.intakes || []).filter(s => s.owner === state.account?.email);
  const query = $('thread-search').value.trim().toLowerCase();
  const managed = sessions.map(s => ({key:s.id, session:s, title:[s.profile['First Name'],s.profile['Last Name']].filter(Boolean).join(' ') || s.email, email:s.email,
    detail:`${s.replyCount || 0} replies · ${s.sentCount}/5 sent · ${labels[s.status] || s.status}`}));
  const external = gmailThreads.filter(t => !sessions.some(s => s.threadId === t.id)).map(t => ({key:'gmail:' + t.id, external:t, title:t.subject, email:t.from || '',detail:`${t.replyCount || 0} replies · ${t.messageCount} messages · Gmail conversation`}));
  const items = [...managed,...external].filter(item => `${item.title} ${item.email} ${item.detail}`.toLowerCase().includes(query));
  $('thread-total').textContent = `${items.length} shown`; $('more-threads').hidden = !nextPageToken;
  const key = JSON.stringify([items,selectedId,selectedExternal?.id]);
  if (key === listKey) { for (const b of $('thread-list').querySelectorAll('button')) b.disabled = working || offline; return; }
  listKey = key; $('thread-list').replaceChildren();
  if (!items.length) { const li=document.createElement('li');li.className='small';li.textContent=query?'No matching conversations.':'Generate an intro or load your Gmail threads to get started.';$('thread-list').append(li); }
  for (const item of items) {
    const li=document.createElement('li'), b=document.createElement('button'), title=document.createElement('strong'), email=document.createElement('span'), meta=document.createElement('span');
    b.type='button';b.className='thread-choice';b.disabled=working||offline;b.setAttribute('aria-current',String(item.session ? selectedId===item.key : selectedExternal?.id===item.external.id));
    title.textContent=item.title;email.textContent=item.email;meta.textContent=item.detail;b.append(title,email,meta);
    b.addEventListener('click',()=>run(b,'Opening…',()=>openConversation(item)));li.append(b);$('thread-list').append(li);
  }
}
function renderHistory() {
  const key = JSON.stringify([selectedId,selectedExternal?.id,selectedThread?.id,selectedThread?.version]);
  if (key === historyKey) return;
  const open = new Set([...$('thread-messages').querySelectorAll('details[open]')].map(el=>el.dataset.id));
  historyKey=key;$('thread-messages').replaceChildren();
  if (!selectedThread) {const p=document.createElement('p');p.className='small';p.textContent=current()?.threadId?'Choose Refresh thread to load the message history.':'The introduction has not been sent yet.';$('thread-messages').append(p);return;}
  const messages=selectedThread.messages.filter(m=>!m.isDraft);
  messages.forEach((m,i)=>{const d=document.createElement('details'),summary=document.createElement('summary'),meta=document.createElement('p'),body=document.createElement('pre');
    d.className='thread-message';d.dataset.id=m.id;d.open=open.has(m.id)||i===messages.length-1;
    summary.textContent=`${m.from} · ${m.date || 'Date unavailable'}`;meta.textContent=`To: ${m.to}${m.attachments?.length?' · Attachments excluded: '+m.attachments.join(', '):''}`;body.textContent=m.body||'(No readable message text)';d.append(summary,meta,body);$('thread-messages').append(d);});
}
function renderDetail() {
  const session=current(), external=selectedExternal;
  $('new-conversation').hidden=Boolean(session||external);$('conversation-detail').hidden=!session&&!external;
  if (!session&&!external) return;
  const started=Boolean(session?.threadId), cap=session?.sentCount >= (state.intakeMaxEmails || 5), terminal=session&&['complete','stopped','archived','send_uncertain','sending'].includes(session.status);
  $('conversation-title').textContent=session?([session.profile['First Name'],session.profile['Last Name']].filter(Boolean).join(' ')||session.email):external.subject;
  $('conversation-email').textContent=session?session.email:external.from||'';
  $('conversation-status').textContent=offline?'Server unavailable':session?(labels[session.status]||session.status):'Gmail conversation';
  const replyCount=session?session.replyCount||0:selectedThread?.messages.filter(m=>!m.sentByOwner&&!m.isDraft).length||0;
  const sentCount=session?session.sentCount:selectedThread?.messages.filter(m=>m.sentByOwner&&!m.isDraft).length||0;
  $('reply-count').textContent=replyCount;$('sent-count').textContent=`${sentCount} / ${state.intakeMaxEmails||5}`;$('message-count').textContent=session?session.messageCount||0:selectedThread?.messages.filter(m=>!m.isDraft).length||0;
  $('conversation-help').textContent=!session?'Generate reply to continue this conversation as a profile intake, using its complete history. Its existing outgoing messages count toward the five-email limit.'
    :session.status==='limit_reached'?'This thread has used its five-email limit. Late replies are still recorded. Start a new thread explicitly to continue with the same person and spreadsheet row.'
    :session.status==='complete'?'All profile fields are filled or explicitly declined. No further email is needed.'
    :session.status==='stopped'?'The recipient asked to stop. Further intake emails are blocked.'
    :!started?'Generate and review your introduction, then send it to start the thread.'
    :session.autoReply===true?'Automatic follow-ups are enabled. Turn them off to generate and review a reply yourself.'
    :'Generate reply continues this conversation using its full history, even without a new response. Review the preview, then send. Nothing is sent automatically.';
  $('conversation-error').textContent=session?.error||'';$('conversation-error').hidden=!session?.error;
  $('generate-next').textContent=started||external?'Generate reply':'Generate intro';
  $('generate-next').disabled=working||offline||!state.account||!state.serviceAccountFound||cap||terminal||Boolean(session?.autoReply)||Boolean(session&&['paused','error'].includes(session.status))||Boolean(threadLoadError);
  $('pause-thread').hidden=!session||!['ready','waiting','reply_ready','followup_ready','error'].includes(session.status);
  $('resume-thread').hidden=!session||!['paused','error'].includes(session.status);
  $('new-thread').hidden=!session||!['limit_reached','paused','error','send_uncertain'].includes(session.status);
  $('automation-label').hidden=!session||terminal||cap;
  $('auto-reply').checked=session?.autoReply===true;$('auto-reply').disabled=working||offline||terminal;
  $('reload-thread').disabled=working||offline||!state.account||Boolean(session&&!session.threadId);
  $('thread-loading').textContent=threadLoadError||(lastThreadRefresh?`Last checked ${new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(lastThreadRefresh)}.`:'');
  const draft=session?.pendingDraft;
  $('reply-preview').hidden=!draft;
  $('preview-heading').textContent=started?'Reply preview':'Introduction preview';
  $('preview-recipient').textContent=session?`From: Cosmos <${session.owner}> · To: ${session.email}`:'';
  $('preview-subject').textContent=draft?.subject||'';$('preview-body').textContent=draft?.body||'';
  $('send-preview').textContent=started?'Send reply':'Send intro';
  $('send-preview').disabled=working||offline||!draft||terminal||cap||Boolean(session?.autoReply&&started)||!['ready','reply_ready','followup_ready'].includes(session?.status);
  $('profile-details').hidden=!session;
  if(session){const fields=session.fields||state.intakeFields, answerFields=session.answerFields||fields.filter(f=>!['personid','email'].includes(f.toLowerCase().replace(/[^a-z0-9]/g,''))),missing=answerFields.filter(f=>!String(session.profile[f]||'').trim());$('profile-summary').textContent=`Collected profile details · ${answerFields.length-missing.length}/${answerFields.length} resolved`;
    const key=JSON.stringify([session.profile,fields]);if(key!==profileKey){profileKey=key;$('profile-fields').replaceChildren();fields.forEach(field=>{const div=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=field;dd.textContent=session.profile[field]||'Not yet provided';div.append(dt,dd);$('profile-fields').append(div,);});}}
  renderHistory();
}
function render() {
  for(const button of document.querySelectorAll('button'))button.disabled=working||offline||!state;
  if(!state)return;
  $('gemini-status').textContent=offline?'Server unavailable':state.diagnostics?.gemini?.ok?'Connected':state.serviceAccountFound?'Credentials found':'Credentials missing';
  $('gmail-status').textContent=offline?'Server unavailable':state.account?.email||'Not connected';
  $('connect').textContent=state.account?'Reconnect Gmail':'Connect Gmail';$('connect').setAttribute('aria-disabled',String(!state.oauthFound||working||offline));
  if(state.sheet?.url){$('sheet-link').href=state.sheet.url;if(document.activeElement!==$('sheet-input'))$('sheet-input').value=state.sheet.url;}
  $('oauth-help').textContent=!state.oauthFound?'OAuth client credentials are missing. Add the JSON file and restart.':!state.account?'Sign in to read conversations and send email.':!state.canReadThreads&&!state.diagnostics?.threads?.ok?'Reconnect Gmail and approve email-reading access.':'Connected Gmail sends as Cosmos. Profiles use the shared spreadsheet.';
  $('generate-intro').disabled=working||offline||!state.account||!state.serviceAccountFound;
  $('refresh-threads').disabled=working||offline||!state.account;$('more-threads').disabled=working||offline||!state.account;
  $('connect-sheet').disabled=working||offline||!state.serviceAccountFound;
  $('person-email').disabled=working||offline;
  $('diagnostics').hidden=!state.diagnostics;$('diagnostics').replaceChildren();
  for(const key of ['gemini','gmail','threads']){const result=state.diagnostics?.[key];if(!result)continue;const div=document.createElement('div'),strong=document.createElement('strong'),span=document.createElement('span');div.className='diagnostic'+(result.ok?'':' failed');strong.textContent=`${key==='threads'?'Thread reading':key==='gemini'?'Gemini':'Gmail'} · ${result.ok?'Passed':'Needs attention'}`;span.textContent=result.detail;div.append(strong,span);$('diagnostics').append(div);}
  renderList();renderDetail();
}
async function refresh() {
  try{const next=await api('status');const email=next.account?.email||'';if(owner!==null&&owner!==email){selectedId=null;selectedExternal=null;selectedThread=null;gmailThreads=[];nextPageToken=null;}
    owner=email;state=next;const recovered=offline;offline=false;if(selectedId&&!current()){selectedId=null;selectedThread=null;}render();if(recovered)notice('Connection restored.');}
  catch(error){offline=true;render();notice('Cannot reach the local app. Start it with npm start and refresh.',true);throw error;}
}
async function loadSelected() {
  if(!selectedId&&!selectedExternal)return;
  const id=selectedId, externalId=selectedExternal?.id;
  try{const result=id?await api('intake/thread',{id}):await api('thread',{id:externalId});
    if(selectedId!==id||selectedExternal?.id!==externalId)return;
    if(result.session)acceptSession(result.session);selectedThread=result.thread;threadLoadError='';lastThreadRefresh=new Date();render();}
  catch(error){if(selectedId===id&&selectedExternal?.id===externalId){threadLoadError=`Could not load the current thread: ${error.message}`;render();}throw error;}
}
async function openConversation(item) {
  selectedId=item.session?.id||null;selectedExternal=item.external||null;selectedThread=null;threadLoadError='';lastThreadRefresh=null;historyKey=null;render();await loadSelected();
}
async function loadGmail(append=false) {
  const result=await api('threads',{pageToken:append?nextPageToken:''});
  gmailThreads=append?[...gmailThreads,...result.threads.filter(t=>!gmailThreads.some(old=>old.id===t.id))]:result.threads;nextPageToken=result.nextPageToken;render();
}
async function run(button,label,action){if(working||offline||!state)return;working=true;const original=button.textContent;button.textContent=label;for(const b of document.querySelectorAll('button'))b.disabled=true;notice('');
  try{await action();}catch(error){notice(error.message||'The request failed.',true);}finally{working=false;button.textContent=original;try{await refresh();}catch{}render();}}
$('intro-form').addEventListener('submit',event=>{event.preventDefault();run($('generate-intro'),'Generating intro…',async()=>{const {session}=await api('intake/preview',{email:$('person-email').value.trim(),autoReply:false});acceptSession(session);selectedId=session.id;selectedExternal=null;selectedThread=null;threadLoadError='';lastThreadRefresh=null;render();notice('Introduction ready. Review it, then choose Send intro.');});});
$('new-person').addEventListener('click',()=>{selectedId=null;selectedExternal=null;selectedThread=null;threadLoadError='';lastThreadRefresh=null;render();$('person-email').focus();});
$('thread-search').addEventListener('input',renderList);
$('refresh-threads').addEventListener('click',()=>run($('refresh-threads'),'Loading…',()=>loadGmail()));
$('more-threads').addEventListener('click',()=>run($('more-threads'),'Loading…',()=>loadGmail(true)));
$('reload-thread').addEventListener('click',()=>run($('reload-thread'),'Checking…',async()=>{await loadSelected();if(selectedExternal)await loadGmail();const session=current(),replies=session?.replyCount??selectedThread?.messages.filter(m=>!m.sentByOwner&&!m.isDraft).length??0;notice(`Thread refreshed. ${replies} recipient ${replies===1?'reply':'replies'} loaded.`);}));
$('generate-next').addEventListener('click',()=>run($('generate-next'),'Generating…',async()=>{
  if(selectedExternal){const {session}=await api('intake/import',{threadId:selectedExternal.id});acceptSession(session);selectedId=session.id;selectedExternal=null;}
  const session=current();const {session:updated}=await api(session.threadId?'intake/generate-reply':'intake/generate-intro',{id:session.id});acceptSession(updated);await loadSelected();notice(updated.pendingDraft?'Preview ready. Review it before sending.':'This profile is complete or the recipient asked to stop. No reply was generated.');
}));
$('send-preview').addEventListener('click',()=>run($('send-preview'),'Sending…',async()=>{const session=current();const {session:updated}=await api('intake/send-preview',{id:session.id,draftId:session.pendingDraft.id});acceptSession(updated);notice(`Email sent to ${updated.email}. ${updated.sentCount}/5 outgoing emails used.`);try{await loadSelected();}catch{notice('Email sent. Thread history could not refresh; use Refresh thread.',true);}}));
for(const action of ['pause','resume'])$(action+'-thread').addEventListener('click',()=>run($(action+'-thread'),'Saving…',async()=>{const {session}=await api('intake/control',{id:selectedId,action});acceptSession(session);notice(action==='pause'?'Thread paused.':'Thread resumed.');}));
$('new-thread').addEventListener('click',()=>run($('new-thread'),'Generating intro…',async()=>{const previous=current();const {session}=await api('intake/preview',{email:previous.email,previousId:previous.id,autoReply:false});acceptSession(session);selectedId=session.id;selectedThread=null;threadLoadError='';lastThreadRefresh=null;render();notice('New thread introduction ready. Collected details and Person ID are preserved.');}));
$('auto-reply').addEventListener('change',()=>{const enabled=$('auto-reply').checked;run($('generate-next'),'Saving…',async()=>{const {session}=await api('intake/automation',{id:selectedId,enabled});acceptSession(session);notice(enabled?'Automatic follow-ups enabled for this thread, up to five outgoing emails.':'Review mode enabled. Generate and send replies yourself.');});});
$('check-sheet').addEventListener('click',()=>run($('check-sheet'),'Checking…',async()=>{const {sheet}=await api('intake/check-sheet',{});$('sheet-result').textContent=`${sheet.title} / ${sheet.tab}: ${sheet.detail}`;if(sheet.url)$('sheet-link').href=sheet.url;notice('Spreadsheet headers match. No test cells were written.');}));
$('connect-sheet').addEventListener('click',()=>run($('connect-sheet'),'Connecting…',async()=>{const {sheet}=await api('intake/connect-sheet',{url:$('sheet-input').value.trim()});$('sheet-link').href=sheet.url;$('sheet-input').value=sheet.url;$('sheet-result').textContent=`${sheet.title} / ${sheet.tab}: ${sheet.detail}`;notice('Spreadsheet connected.');}));
$('test').addEventListener('click',()=>run($('test'),'Testing…',async()=>{const results=await api('diagnose',{});notice(results.gemini.ok&&results.gmail.ok&&results.threads?.ok?'All connections passed.':'Review the connection test results.',!results.gemini.ok||!results.gmail.ok||!results.threads?.ok);}));
$('connect').addEventListener('click',event=>{if(!state?.oauthFound||working||offline)event.preventDefault();});
refresh().then(async()=>{const id=new URLSearchParams(location.search).get('thread');if(id&&state.intakes?.some(s=>s.id===id)){selectedId=id;await loadSelected();}else{const latest=state.intakes?.find(s=>s.owner===state.account?.email);if(latest){selectedId=latest.id;try{await loadSelected();}catch{}}}
  if(state.account)try{await loadGmail();}catch(error){notice(`Saved threads loaded. Gmail list could not refresh: ${error.message}`,true);}render();
}).catch(()=>{});
setInterval(async()=>{if(working||document.hidden)return;try{await refresh();if(!working&&(selectedId||selectedExternal))await loadSelected();}catch{}},15000);
