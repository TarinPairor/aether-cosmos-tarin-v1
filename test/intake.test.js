import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/storage.js';
import { IntakeService, applyFacts, authoredText } from '../lib/intake.js';
import { ANSWER_FIELDS } from '../lib/intake-fields.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bananra-test-')); t.after(() => rm(dir, {recursive:true,force:true}));
  const store = new Store(dir); await store.write('gmail-account', {email:'sender@example.com'});
  const rows = new Map(), threads = new Map(), sent = [], calls = [];
  let plan = {subject:'Hello', body:'Hi, I’m Bananra, an assistant helping with your profile. What is your name and where are you based?', facts:[]};
  const sheets = {
    lookup: async email => ({profile:structuredClone(rows.get(email)?.profile || {}),row:rows.get(email)?.row || null,fields:(await import('../lib/intake-fields.js')).FIELDS}),
    upsert: async profile => { const row=rows.get(profile.Email)?.row || rows.size+2; rows.set(profile.Email,{row,profile:structuredClone(profile)}); return {row,url:'https://example.com/sheet'}; },
  };
  const google = {
    identity: async () => ({email:'sender@example.com'}), checkReadAccess:async()=>true,
    planIntake:async args => { calls.push(structuredClone(args)); return structuredClone(plan); },
    getThread:async id => structuredClone(threads.get(id)),
    send:async draft => {
      const id='sent-'+(sent.length+1), threadId=draft.threadId || 'thread-'+(sent.length+1);
      const thread=threads.get(threadId) || {id:threadId,subject:draft.subject,messages:[]};
      thread.messages.push({id,from:'sender@example.com',to:draft.to,subject:draft.subject,messageId:`<${id}@example.com>`,references:'',body:draft.body,attachments:[],sentByOwner:true});
      thread.version=thread.messages.map(m=>m.id).join('-'); threads.set(threadId,thread); sent.push(structuredClone(draft));
      return {id,threadId,to:draft.to};
    },
  };
  const service=new IntakeService({store,google,sheets});
  const prepareManual=service.prepare.bind(service);
  service.prepare=(email,previousId=null)=>prepareManual(email,previousId,{autoReply:true});
  function reply(session,body,from='person@example.com') {
    const thread=threads.get(session.threadId), id='reply-'+thread.messages.length;
    const message={id,from,to:'sender@example.com',subject:'Re: '+thread.subject,messageId:`<${id}@example.com>`,references:'',body,attachments:[]};
    thread.messages.push(message); thread.version=thread.messages.map(m=>m.id).join('-'); return message;
  }
  return {service,store,google,sheets,rows,threads,sent,calls,reply,prepareManual,setPlan:p=>{plan={subject:'Follow-up',body:'Thanks for sharing that. What else would you like to tell me?',facts:[],...p};}};
}

test('opening is previewed, writes identity once, and waits for replies without random reminders', async t=>{
 const f=await fixture(t), session=await f.service.prepare('person@example.com');
 assert.equal(f.sent.length,0); assert.equal(f.rows.size,0); assert.equal(session.sentCount,0);
 await f.service.start(session.id); assert.equal(f.sent.length,1); assert.equal(f.sent[0].fromName,'Bananra');
 assert.equal(f.rows.size,1); assert.equal(f.rows.get(session.email).profile.Email,session.email);
 await f.service.poll(); await f.service.poll(); assert.equal(f.sent.length,1);
 await assert.rejects(()=>f.service.start(session.id),/already started/);
});
test('intake fields and LLM schema come from the spreadsheet header row', async t=>{
 const f=await fixture(t), fields=['Email','Preferred Name','Favorite Color'];
 f.sheets.lookup=async()=>({profile:{},row:null,fields});
 const session=await f.service.prepare('person@example.com');
 assert.deepEqual(session.fields,fields);assert.deepEqual(session.answerFields,['Preferred Name','Favorite Color']);
 assert.deepEqual(f.calls[0].session.fields,fields);assert.deepEqual(f.calls[0].session.answerFields,['Preferred Name','Favorite Color']);
 await f.service.start(session.id);const reply=f.reply(await f.service.get(session.id),'My favorite color is green.');
 f.setPlan({facts:[{field:'Favorite Color',value:'green',messageId:reply.id,evidence:'My favorite color is green.'}]});
 await f.service.poll();
 assert.equal((await f.service.get(session.id)).profile['Favorite Color'],'green');
});
test('extracts recipient evidence into the same row and follows up only once per reply',async t=>{
 const f=await fixture(t); let s=await f.service.prepare('person@example.com'); await f.service.start(s.id); s=await f.service.get(s.id);
 const m=f.reply(s,'My first name is Maya. My city is Singapore.');
 f.setPlan({facts:[{field:'First Name',value:'Maya',messageId:m.id,evidence:'My first name is Maya.'},{field:'City',value:'Singapore',messageId:m.id,evidence:'My city is Singapore.'}]});
 await f.service.poll(); s=await f.service.get(s.id);
 assert.equal(s.profile['First Name'],'Maya'); assert.equal(s.profile.City,'Singapore'); assert.equal(s.sheetRow,2); assert.equal(f.rows.size,1);
 assert.equal(f.sent.length,2); assert.equal(f.calls.at(-1).thread.messages.length,2); assert.equal(f.sent[1].threadId,s.threadId);
 await f.service.poll(); assert.equal(f.sent.length,2);
});
test('hard cap survives restart, saves a late reply, and requires explicit new thread',async t=>{
 const f=await fixture(t); let s=await f.service.prepare('person@example.com'); await f.service.start(s.id);
 for(let i=0;i<4;i++){s=await f.service.get(s.id); f.reply(s,'I would like to continue.'); f.setPlan({}); await f.service.poll();}
 s=await f.service.get(s.id); assert.equal(s.sentCount,5); assert.equal(s.status,'limit_reached'); assert.equal(f.sent.length,5);
 const restarted=new IntakeService({store:f.store,google:f.google,sheets:f.sheets});
 const message=f.reply(s,'My city is Paris.'); f.setPlan({facts:[{field:'City',value:'Paris',messageId:message.id,evidence:'My city is Paris.'}]});
 await restarted.poll(); assert.equal(f.sent.length,5); assert.equal(f.rows.get(s.email).profile.City,'Paris');
 const next=await restarted.prepare(s.email,s.id); assert.equal(next.sentCount,0); assert.equal(next.profile['Person ID'],s.profile['Person ID']); assert.equal(next.profile.City,'Paris'); assert.equal(f.sent.length,5);
 await restarted.start(next.id); assert.equal(f.sent.length,6); const newSession=await restarted.get(next.id);
 assert.notEqual(newSession.threadId,s.threadId); assert.equal(newSession.sentCount,1); assert.equal(f.rows.size,1); assert.equal((await restarted.get(s.id)).status,'archived');
});
test('complete or declined profiles stop follow-ups and recipient stop requests stay stopped',async t=>{
 const f=await fixture(t); let s=await f.service.prepare('person@example.com'); await f.service.start(s.id); s=await f.service.get(s.id);
 const m=f.reply(s,'Please stop emailing me.'); f.setPlan({stopRequested:true,stopMessageId:m.id,stopEvidence:'Please stop emailing me.'});
 await f.service.poll(); assert.equal((await f.service.get(s.id)).status,'stopped'); assert.equal(f.sent.length,1);
 await assert.rejects(()=>f.service.prepare(s.email,s.id),/asked to stop/);
 await assert.rejects(()=>f.service.control(s.id,'resume'),/cannot be resumed/);
});
test('resolved final field records completion without sending an unnecessary follow-up',async t=>{
 const f=await fixture(t); const existing=Object.fromEntries(ANSWER_FIELDS.filter(x=>x!=='First Name').map(x=>[x,'Declined']));
 f.rows.set('person@example.com',{row:2,profile:{...existing,'Person ID':'existing-person',Email:'person@example.com'}});
 let s=await f.service.prepare('person@example.com'); await f.service.start(s.id); s=await f.service.get(s.id);
 const m=f.reply(s,'My first name is Maya.'); f.setPlan({facts:[{field:'First Name',value:'Maya',messageId:m.id,evidence:'My first name is Maya.'}]});
 await f.service.poll(); assert.equal((await f.service.get(s.id)).status,'complete'); assert.equal(f.sent.length,1); assert.equal(f.rows.size,1);
});
test('fabricated, inferred, own-message and unknown-column facts are rejected',()=>{
 const session={profile:{'Person ID':'p1',Email:'person@example.com'},evidence:{}};
 const incoming=[{id:'reply-1',body:'My name is Alex. I prefer not to share my gender. My DOB is 2000-02-30.'}];
 const result=applyFacts(session,{facts:[
  {field:'First Name',value:'Alex',messageId:'reply-1',evidence:'My name is Alex.'},
  {field:'Gender',value:'Male',messageId:'reply-1',evidence:'My name is Alex.'},
  {field:'City',value:'London',messageId:'reply-1',evidence:'I live in London.'},
  {field:'Last Name',value:'Guess',messageId:'sent-1',evidence:'My name is Alex.'},
  {field:'Person ID',value:'injected',messageId:'reply-1',evidence:'My name is Alex.'},
  {field:'Date of Birth',value:'2000-02-30',messageId:'reply-1',evidence:'My DOB is 2000-02-30.'},
  {field:'Gender',declined:true,messageId:'reply-1',evidence:'I prefer not to share my gender.'},
 ]},incoming);
 assert.deepEqual(result.profile,{'Person ID':'p1',Email:'person@example.com','First Name':'Alex',Gender:'Declined'});
 assert.equal(authoredText('My name is Alex.\n\nOn yesterday Friend wrote:\nOld details'),'My name is Alex.');
});
test('uncertain sends reserve a quota slot and never auto-retry after restart',async t=>{
 const f=await fixture(t); const s=await f.service.prepare('person@example.com'); let attempts=0;
 f.google.send=async()=>{attempts++;throw new Error('timeout');};
 await assert.rejects(()=>f.service.start(s.id)); const stored=await f.service.get(s.id);
 assert.equal(stored.status,'send_uncertain'); assert.equal(stored.sentCount,1);
 await f.service.poll(); assert.equal(attempts,1);
 stored.status='sending'; await f.service.save(stored); await f.service.poll();
 assert.equal((await f.service.get(s.id)).status,'send_uncertain'); assert.equal(attempts,1);
});
test('spreadsheet failure prevents opening email and pauses follow-up until a safe resume',async t=>{
 const f=await fixture(t); const upsert=f.sheets.upsert;
 const s=await f.service.prepare('person@example.com'); f.sheets.upsert=async()=>{throw new Error('offline');};
 await assert.rejects(()=>f.service.start(s.id)); assert.equal(f.sent.length,0);
 f.sheets.upsert=upsert; await f.service.start(s.id); const active=await f.service.get(s.id);
 const message=f.reply(active,'My city is Rome.'); f.setPlan({facts:[{field:'City',value:'Rome',messageId:message.id,evidence:'My city is Rome.'}]});
 f.sheets.upsert=async()=>{throw new Error('offline');}; await f.service.poll();
 assert.equal((await f.service.get(s.id)).status,'error'); assert.equal(f.sent.length,1);
 f.sheets.upsert=upsert; await f.service.control(s.id,'resume'); await f.service.poll();
 assert.equal(f.sent.length,2); assert.equal(f.rows.get(active.email).profile.City,'Rome'); assert.equal(f.rows.size,1);
});
test('unrelated participants and drafts cannot supply facts or trigger follow-ups',async t=>{
 const f=await fixture(t); const s=await f.service.prepare('person@example.com'); await f.service.start(s.id); const active=await f.service.get(s.id);
 f.reply(active,'My name is Intruder.','other@example.com'); const draft=f.reply(active,'My name is Unsent.'); draft.isDraft=true;
 await f.service.poll(); assert.equal(f.sent.length,1); assert.equal(f.calls.length,1);
});

test('opt-out stays suppressed even if Sheets fails or a recoverable status changes',async t=>{
 const f=await fixture(t); let s=await f.service.prepare('person@example.com'); await f.service.start(s.id); s=await f.service.get(s.id);
 const message=f.reply(s,'Please stop emailing me.'); f.setPlan({stopRequested:true,stopMessageId:message.id,stopEvidence:'Please stop emailing me.'});
 const upsert=f.sheets.upsert; f.sheets.upsert=async()=>{throw new Error('offline');};
 await f.service.poll(); s=await f.service.get(s.id); assert.equal(s.status,'stopped'); assert.ok(s.optedOutAt); assert.equal(s.syncPending,true);
 await assert.rejects(()=>f.service.prepare(s.email,s.id),/asked to stop/);
 s.status='error';s.resumeStatus='stopped';await f.service.save(s);
 await assert.rejects(()=>f.service.prepare(s.email,s.id),/asked to stop/);
 f.sheets.upsert=upsert; await f.service.control(s.id,'resume');
 assert.equal((await f.service.get(s.id)).status,'stopped'); await f.service.poll(); assert.equal(f.sent.length,1);
});
test('terminal pending spreadsheet updates recover after restart without sending',async t=>{
 for(const status of ['complete','stopped']) {
   const f=await fixture(t); const session=await f.service.prepare('person@example.com');
   session.status=status;session.syncPending=true;session.profile.City='Last reply city';if(status==='stopped')session.optedOutAt=new Date().toISOString();
   await f.service.save(session);
   const restarted=new IntakeService({store:f.store,google:f.google,sheets:f.sheets});await restarted.poll();
   const saved=await restarted.get(session.id);assert.equal(saved.status,status);assert.equal(saved.syncPending,false);assert.equal(f.rows.get(session.email).profile.City,'Last reply city');assert.equal(f.sent.length,0);
 }
});
test('named birth dates are validated as calendar dates in Singapore timezone',()=>{
 const previous=process.env.TZ;process.env.TZ='Asia/Singapore';
 try {
  for(const evidence of ['My DOB is 1 May 2000.','My DOB is May 1st, 2000.']) {
   const result=applyFacts({profile:{},evidence:{}},{facts:[{field:'Date of Birth',value:'2000-05-01',messageId:'r1',evidence}]},[{id:'r1',body:evidence}]);
   assert.equal(result.profile['Date of Birth'],'2000-05-01');
  }
 } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('review mode switches from introduction to reply without sending previews automatically',async t=>{
 const f=await fixture(t);const intro=await f.prepareManual('person@example.com');
 assert.equal(intro.autoReply,false);assert.equal(intro.sentCount,0);
 await assert.rejects(()=>f.service.generateReply(intro.id),/Send the introduction/);
 await f.service.sendPreview(intro.id,intro.pendingDraft.id);let s=await f.service.get(intro.id);
 assert.equal(f.sent.length,1);assert.equal(s.sentCount,1);
 await assert.rejects(()=>f.service.generateIntro(s.id),/already been sent/);
 const m=f.reply(s,'My first name is Maya.');f.setPlan({facts:[{field:'First Name',value:'Maya',messageId:m.id,evidence:'My first name is Maya.'}]});
 await f.service.poll();s=await f.service.generateReply(s.id);
 assert.equal(s.status,'reply_ready');assert.equal(f.sent.length,1);assert.equal(s.profile['First Name'],'Maya');
 const loaded=await f.service.conversation(s.id);assert.equal(loaded.session.replyCount,1);assert.equal(loaded.session.messageCount,2);assert.equal(loaded.thread.messages.length,2);
 const draftId=s.pendingDraft.id;await f.service.sendPreview(s.id,draftId);
 assert.equal(f.sent.length,2);assert.equal((await f.service.conversation(s.id)).session.messageCount,3);
 await assert.rejects(()=>f.service.sendPreview(s.id,draftId),/preview changed/);
 await f.service.poll();assert.equal(f.sent.length,2);
});
test('a stale reply preview refreshes without consuming a send slot',async t=>{
 const f=await fixture(t);let s=await f.prepareManual('person@example.com');await f.service.start(s.id);s=await f.service.get(s.id);
 f.reply(s,'Hello there.');await f.service.poll();s=await f.service.get(s.id);const draftId=s.pendingDraft.id;
 const m=f.reply(s,'My city is Paris.');f.setPlan({facts:[{field:'City',value:'Paris',messageId:m.id,evidence:'My city is Paris.'}]});
 await assert.rejects(()=>f.service.sendPreview(s.id,draftId),/New messages arrived/);
 s=await f.service.get(s.id);assert.equal(s.sentCount,1);assert.equal(f.sent.length,1);assert.notEqual(s.pendingDraft.id,draftId);assert.equal(s.profile.City,'Paris');
 await f.service.sendPreview(s.id,s.pendingDraft.id);assert.equal(f.sent.length,2);
});
test('opening a managed conversation preserves its identity and five-email counter',async t=>{
 const f=await fixture(t);const s=await f.prepareManual('person@example.com');await f.service.start(s.id);const saved=await f.service.get(s.id);
 const imported=await f.service.importConversation(saved.threadId);assert.equal(imported.id,s.id);assert.equal(imported.sentCount,1);assert.equal((await f.service.list()).length,1);
 const foreignStore=new Store(path.join(f.store.directory,'foreign'));await foreignStore.write('gmail-account',{email:'different@example.com'});
 const foreign=new IntakeService({store:f.store,google:f.google,sheets:f.sheets});await f.store.write('gmail-account',{email:'different@example.com'});
 await assert.rejects(()=>foreign.conversation(s.id),/owns this thread/);
});
test('existing Gmail conversations are imported with their sent count and full history',async t=>{
 const f=await fixture(t);
 f.threads.set('legacy-thread',{id:'legacy-thread',version:'v1',subject:'Existing conversation',messages:[
  {id:'old-sent',from:'sender@example.com',to:'legacy@example.com',subject:'Existing conversation',messageId:'<old-sent@example.com>',references:'',sentByOwner:true,body:'Hello',attachments:[]},
  {id:'old-reply',from:'legacy@example.com',to:'sender@example.com',subject:'Re: Existing conversation',messageId:'<old-reply@example.com>',references:'<old-sent@example.com>',body:'My city is Paris.',attachments:[]},
 ]});
 const s=await f.service.importConversation('legacy-thread');assert.equal(s.autoReply,false);assert.equal(s.sentCount,1);assert.equal(s.replyCount,1);assert.equal(s.email,'legacy@example.com');
 f.setPlan({facts:[{field:'City',value:'Paris',messageId:'old-reply',evidence:'My city is Paris.'}]});
 const next=await f.service.generateReply(s.id);assert.equal(next.pendingDraft.threadId,'legacy-thread');assert.equal(next.profile.City,'Paris');assert.equal(f.sent.length,0);
});
test('manual reply previews also enforce the five-email limit',async t=>{
 const f=await fixture(t);let s=await f.prepareManual('person@example.com');await f.service.start(s.id);
 for(let i=0;i<4;i++){s=await f.service.get(s.id);f.reply(s,'I would like to continue.');await f.service.poll();s=await f.service.generateReply(s.id);await f.service.sendPreview(s.id,s.pendingDraft.id);}
 s=await f.service.get(s.id);assert.equal(s.sentCount,5);assert.equal(s.status,'limit_reached');
 await assert.rejects(()=>f.service.generateReply(s.id),/Five emails/);assert.equal(f.sent.length,5);
});

test('Generate reply can proactively continue a thread without a new recipient response',async t=>{
 const f=await fixture(t);let s=await f.prepareManual('person@example.com');await f.service.start(s.id);
 s=await f.service.generateReply(s.id);
 assert.equal(s.status,'reply_ready');assert.equal(f.sent.length,1);assert.equal(s.sentCount,1);
 assert.equal(s.pendingDraft.threadId,s.threadId);assert.match(s.pendingDraft.inReplyTo,/<sent-1@example.com>/);
 assert.equal(f.calls.at(-1).continuation,true);assert.equal(f.calls.at(-1).thread.messages.length,1);assert.equal(f.calls.at(-1).incoming.length,0);
 await f.service.sendPreview(s.id,s.pendingDraft.id);assert.equal(f.sent.length,2);assert.equal(f.sent[1].to,'person@example.com');
 s=await f.service.generateReply(s.id);assert.equal(s.sentCount,2);assert.equal(f.sent.length,2);assert.equal(f.calls.at(-1).continuation,true);
});
test('background polls never initiate proactive follow-ups without a recipient reply',async t=>{
 const f=await fixture(t);const s=await f.service.prepare('person@example.com');await f.service.start(s.id);
 const calls=f.calls.length;for(let i=0;i<3;i++)await f.service.poll();
 assert.equal(f.sent.length,1);assert.equal(f.calls.length,calls);
});

test('a proactive preview is not auto-sent by enabling reply-driven automation',async t=>{
 const f=await fixture(t);let s=await f.prepareManual('person@example.com');await f.service.start(s.id);s=await f.service.generateReply(s.id);
 assert.equal(s.pendingDraft.proactive,true);await f.service.automation(s.id,true);
 await f.service.poll();await f.service.poll();assert.equal(f.sent.length,1);
});

test('Generate reply refreshes a stale preview after an intervening outgoing message',async t=>{
 const f=await fixture(t);let s=await f.prepareManual('person@example.com');await f.service.start(s.id);s=await f.service.generateReply(s.id);const old=s.pendingDraft.id;
 const thread=f.threads.get(s.threadId);thread.messages.push({id:'outside-send',from:'sender@example.com',to:s.email,sentByOwner:true,subject:thread.subject,messageId:'<outside@example.com>',references:'',body:'Another message',attachments:[]});thread.version+='-outside';
 s=await f.service.generateReply(s.id);assert.notEqual(s.pendingDraft.id,old);assert.equal(s.pendingDraft.threadVersion,thread.version);assert.equal(f.sent.length,1);
});
test('imported Reply-To addresses retain the actual correspondent for replies and extracted facts',async t=>{
 const f=await fixture(t);f.threads.set('replyto-thread',{id:'replyto-thread',version:'v1',subject:'Profile',messages:[
 {id:'reply-from',from:'person@example.com',replyTo:'delivery@example.com',to:'sender@example.com',subject:'Profile',messageId:'<sender@example.com>',references:'',body:'My city is Paris.',attachments:[]},
 ]});
 let s=await f.service.importConversation('replyto-thread');assert.equal(s.email,'delivery@example.com');assert.equal(s.replyCount,1);
 f.setPlan({facts:[{field:'City',value:'Paris',messageId:'reply-from',evidence:'My city is Paris.'}]});s=await f.service.generateReply(s.id);
 assert.equal(s.profile.City,'Paris');assert.equal(s.pendingDraft.to,'delivery@example.com');assert.equal(s.replyCount,1);
});
