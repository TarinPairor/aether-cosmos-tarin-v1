import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../lib/storage.js';
import { createApp, validatePrompt, validateInterval } from '../lib/app.js';
import { encodeEmail, AppError } from '../lib/google.js';

// Dispatch genuine HTTP request handlers without binding a port. This also runs
// inside environments that prohibit listening sockets.
export async function fixture(t, { intake = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aether-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const calls = { sent: 0, generated: 0 };
  const google = {
    hasService: true, hasOAuth: true, model: 'test-model', backend: 'vertex', redirect: 'http://localhost:8081/oauth/callback',
    authUrl: (state, challenge) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
    generate: async (prompt, backend, options) => { calls.generated++; calls.context = options?.thread; return { subject: 'A thoughtful check-in', body: 'How are you today?\nTake one small step.' }; },
    identity: async () => ({ email: 'me@example.com' }),
    send: async draft => { calls.sent++; calls.sentDraft = draft; return { id: 'message-1', to: draft.to || 'me@example.com' }; },
    canReadThreads: async () => true,
    checkReadAccess: async () => 'Reading is available.',
    listThreads: async () => ({ threads: [{ id: 'thread-1', subject: 'Our conversation', messageCount: 2 }], nextPageToken: null }),
    getThread: async () => ({ id: 'thread-1', subject: 'Our conversation', version: 'version-1', messages: [
      { id: 'a', from: 'me@example.com', to: 'friend@example.com', subject: 'Our conversation', messageId: '<a@example.com>', references: '', body: 'Original question', attachments: [] },
      { id: 'b', from: 'Friend <friend@example.com>', to: 'me@example.com', replyTo: 'reply@example.com', subject: 'Re: Our conversation', messageId: '<b@example.com>', references: '<a@example.com>', body: 'Their entire reply', attachments: [] },
    ] }),
    connect: async () => {},
  };
  const app = createApp({ root: process.cwd(), store, google, intake });
  async function request(route, { method = 'GET', data, headers = {} } = {}) {
    const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
    Object.assign(req, { url: route, method, headers: { host: 'localhost:8081', ...headers } });
    return new Promise(resolve => {
      const res = { headers: {}, statusCode: 200,
        setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
        writeHead(status, headers = {}) { this.statusCode = status; Object.entries(headers).forEach(([k,v]) => this.setHeader(k,v)); },
        end(body) { resolve({ status: this.statusCode, headers: this.headers, text: body?.toString() || '', json() { return JSON.parse(this.text); } }); },
      };
      app.server.emit('request', req, res);
    });
  }
  const csrf = (await request('/api/status')).json().csrf;
  const post = (route, data) => request(route, { method: 'POST', data, headers: { origin: 'http://localhost:8081', 'content-type': 'application/json', 'x-csrf-token': csrf } });
  return { ...app, store, calls, google, request, post };
}

test('validates prompts and scheduling bounds', () => {
  assert.equal(validatePrompt(' hi '), 'hi');
  for (const value of ['', null, 'a'.repeat(12001)]) assert.throws(() => validatePrompt(value));
  for (const value of [0, 4, 5.5, 43201, '60']) assert.throws(() => validateInterval(value));
  assert.equal(validateInterval(5), 5); assert.equal(validateInterval(43200), 43200);
});
test('encodes Unicode MIME email and prevents header injection', () => {
  const raw = encodeEmail('me@example.com', { subject: 'Hello 🌿\r\nBcc: other@example.com', body: 'How are you?\n你好' });
  const mime = Buffer.from(raw, 'base64url').toString();
  assert.match(mime, /To: me@example.com\r\n/);
  assert.doesNotMatch(mime, /\r\nBcc:/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replaceAll('\r\n',''), 'base64').toString(), 'How are you?\r\n你好');
  assert.throws(() => encodeEmail('me@example.com\r\nBcc: x@evil.com', { subject: '', body: '' }));
});
test('generates a stored preview and sends once to connected self', async t => {
  const f = await fixture(t);
  const draft = (await f.post('/api/generate', { prompt: 'A daily check-in' })).json().draft;
  assert.equal(f.calls.sent, 0);
  assert.equal((await f.post('/api/send', { draftId: 'wrong-id' })).status, 409);
  const sent = await f.post('/api/send', { draftId: draft.id });
  assert.equal(sent.status, 200); assert.equal(sent.json().sent.to, 'me@example.com');
  assert.equal((await f.post('/api/send', { draftId: draft.id })).status, 409);
  assert.equal(f.calls.sent, 1);
  assert.equal((await f.store.read('history'))[0].type, 'sent');
});
test('blocks forged requests, DNS rebinding and credential downloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/generate', { method: 'POST', data: { prompt: 'Hi' } })).status, 403);
  assert.equal((await f.request('/api/status', { headers: { host: 'evil.example:8081' } })).status, 403);
  for (const route of ['/.data/gmail-token.json', '/gen-lang-client-secret.json', '/client_secret_secret.json', '/../server.js']) assert.equal((await f.request(route)).status, 404);
  const res = await f.request('/'); assert.equal(res.status, 200); assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
});
test('OAuth uses browser-bound state and rejects unsolicited callbacks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/oauth/callback?code=bad&state=bad')).status, 400);
  const start = await f.request('/oauth/start');
  assert.equal(start.status, 302); assert.match(start.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  const state = new URL(start.headers.location).searchParams.get('state');
  assert.equal((await f.request(`/oauth/callback?code=fake&state=${state}`)).status, 400);
  const second = await f.request('/oauth/start');
  const state2 = new URL(second.headers.location).searchParams.get('state');
  assert.equal((await f.request(`/oauth/callback?code=fake&state=${state2}`, { headers: { cookie: second.headers['set-cookie'].split(';')[0] } })).status, 302);
  assert.equal((await f.request('/oauth/start', { headers: { host: '127.0.0.1:8081' } })).headers.location, 'http://localhost:8081/oauth/start');
});
test('diagnostics exercise generation and identity without sending mail', async t => {
  const f = await fixture(t);
  const report = (await f.post('/api/diagnose', {})).json();
  assert.equal(report.gemini.ok, true); assert.equal(report.gmail.ok, true); assert.equal(f.calls.sent, 0);
  f.google.generate = async () => { throw new AppError('API disabled', 502); };
  const failed = (await f.post('/api/diagnose', {})).json();
  assert.equal(failed.gemini.ok, false); assert.equal(failed.gemini.detail, 'API disabled');
});
test('schedule requires passing diagnostics, runs once when due, and can pause', async t => {
  const f = await fixture(t);
  const data = { enabled: true, prompt: 'Daily check-in', intervalMinutes: 5 };
  assert.equal((await f.post('/api/schedule', data)).status, 409);
  await f.post('/api/diagnose', {});
  assert.equal((await f.post('/api/schedule', data)).status, 200);
  await f.tick(); assert.equal(f.calls.sent, 0);
  const config = await f.store.read('schedule'); config.nextRunAt = new Date(0).toISOString(); await f.store.write('schedule', config);
  await Promise.all([f.tick(), f.tick()]); assert.equal(f.calls.sent, 1);
  await f.tick(); assert.equal(f.calls.sent, 1);
  await f.post('/api/schedule', { ...data, enabled: false }); assert.equal((await f.store.read('schedule')).enabled, false);
});
test('scheduled failure pauses delivery and records the error', async t => {
  const f = await fixture(t);
  f.google.send = async () => { throw new AppError('Gmail permission denied', 502); };
  await f.store.write('schedule', { enabled: true, prompt: 'Hi', intervalMinutes: 5, nextRunAt: new Date(0).toISOString() });
  await f.tick(); const schedule = await f.store.read('schedule');
  assert.equal(schedule.enabled, false); assert.equal(schedule.error, 'Gmail permission denied');
  assert.equal((await f.store.read('history'))[0].type, 'error');
});
test('ambiguous manual send cannot be resubmitted', async t => {
  const f = await fixture(t);
  f.google.send = async () => { f.calls.sent++; throw new AppError('Network timed out', 502); };
  const { draft } = (await f.post('/api/generate', { prompt: 'Hi' })).json();
  assert.equal((await f.post('/api/send', { draftId: draft.id })).status, 502);
  assert.equal((await f.post('/api/send', { draftId: draft.id })).status, 409);
  assert.equal(f.calls.sent, 1);
});

test('stores an explicit recipient in the preview and ignores send-time recipient tampering', async t => {
  const f = await fixture(t);
  const { draft } = (await f.post('/api/generate', { prompt: 'Say hello', to: 'friend@example.com' })).json();
  assert.equal(draft.to, 'friend@example.com'); assert.equal(f.calls.sent, 0);
  const response = await f.post('/api/send', { draftId: draft.id, to: 'different@example.com' });
  assert.equal(response.status, 200); assert.equal(response.json().sent.to, 'friend@example.com');
  assert.equal((await f.post('/api/generate', { prompt: 'Hi', to: 'x@example.com\r\nBcc: y@example.com' })).status, 400);
  assert.equal((await f.post('/api/generate', { prompt: 'Hi', to: 'one@example.com,two@example.com' })).status, 400);
});
test('loads full threads and generates replies with every message and fixed reply headers', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/threads', {})).json().threads[0].id, 'thread-1');
  const loaded = (await f.post('/api/thread', { id: 'thread-1' })).json().thread;
  assert.equal(loaded.messages.length, 2); assert.equal(f.calls.generated, 0);
  const { draft } = (await f.post('/api/generate', { prompt: 'Reply warmly', threadId: 'thread-1' })).json();
  assert.equal(f.calls.context.messages.length, 2);
  assert.equal(f.calls.context.messages[0].body, 'Original question');
  assert.equal(f.calls.context.messages[1].body, 'Their entire reply');
  assert.equal(draft.to, 'reply@example.com'); assert.equal(draft.subject, 'Re: Our conversation');
  assert.equal(draft.threadId, 'thread-1'); assert.equal(draft.threadVersion, 'version-1');
  assert.equal(draft.inReplyTo, '<b@example.com>'); assert.equal(draft.contextMessageCount, 2);
  assert.equal(draft.fromAccount, 'me@example.com'); assert.equal(f.calls.sent, 0);
  assert.equal((await f.post('/api/generate', { prompt: 'Reply', threadId: 'thread-1', to: 'different@example.com' })).status, 400);
  assert.equal((await f.post('/api/thread', { id: '../gmail-token' })).status, 400);
});
test('scheduled check-ins ignore external recipients and thread IDs', async t => {
  const f = await fixture(t);
  await f.post('/api/diagnose', {});
  await f.post('/api/schedule', { enabled: true, prompt: 'Check in', intervalMinutes: 5, to: 'friend@example.com', threadId: 'thread-1' });
  const config = await f.store.read('schedule');
  assert.equal(config.to, undefined); assert.equal(config.threadId, undefined);
  config.nextRunAt = new Date(0).toISOString(); await f.store.write('schedule', config); await f.tick();
  assert.equal(f.calls.sentDraft.to, undefined); assert.equal(f.calls.sentDraft.threadId, undefined);
});
test('read permission failures do not prevent composing and sending new emails', async t => {
  const f = await fixture(t);
  f.google.checkReadAccess = async () => { throw new AppError('Reconnect Gmail and approve reading email.', 403); };
  f.google.getThread = f.google.checkReadAccess;
  const report = (await f.post('/api/diagnose', {})).json();
  assert.equal(report.gmail.ok, true); assert.equal(report.threads.ok, false);
  assert.equal((await f.post('/api/thread', { id: 'thread-1' })).status, 403);
  const { draft } = (await f.post('/api/generate', { prompt: 'Hello', to: 'friend@example.com' })).json();
  assert.equal((await f.post('/api/send', { draftId: draft.id })).status, 200);
});

test('pausing a schedule ignores cleared or invalid composer instructions', async t => {
  const f = await fixture(t);
  await f.post('/api/diagnose', {});
  await f.post('/api/schedule', { enabled: true, prompt: 'Keep checking in', intervalMinutes: 5 });
  const response = await f.post('/api/schedule', { enabled: false, prompt: '', intervalMinutes: 0 });
  assert.equal(response.status, 200);
  const config = await f.store.read('schedule');
  assert.equal(config.enabled, false); assert.equal(config.prompt, 'Keep checking in'); assert.equal(config.intervalMinutes, 5);
});

test('intake mode replaces random scheduled messages and exposes intake actions',async t=>{
 let polls=0;
 const intake={list:async()=>[],poll:async()=>{polls++;},sheets:{inspect:async()=>({fields:['Person ID'],detail:'Matched'})},prepare:async email=>({id:'intake-1',email,status:'ready'}),start:async id=>({id,status:'waiting'}),control:async(id,action)=>({id,status:action})};
 const f=await fixture(t,{intake});
 await f.store.write('schedule',{enabled:true,prompt:'Random old check-in',intervalMinutes:5,nextRunAt:new Date(0).toISOString()});
 await f.tick(); assert.equal(polls,1); assert.equal(f.calls.sent,0); assert.equal(f.calls.generated,0);
 const status=(await f.request('/api/status')).json(); assert.equal(status.intakeMode,true); assert.equal(status.intakeMaxEmails,5);
 assert.equal((await f.post('/api/schedule',{enabled:true,prompt:'Hi',intervalMinutes:5})).status,400);
 assert.equal((await f.post('/api/intake/check-sheet',{})).json().sheet.detail,'Matched');
 assert.equal((await f.post('/api/intake/preview',{email:'person@example.com'})).json().session.status,'ready');
 assert.equal((await f.post('/api/intake/start',{id:'intake-1'})).json().session.status,'waiting');
});
test('manual composer cannot bypass the quota on a managed intake thread',async t=>{
 const intake={list:async()=>[{threadId:'thread-1',sentCount:5,status:'limit_reached'}]};
 const f=await fixture(t,{intake});
 const {draft}=(await f.post('/api/generate',{prompt:'Reply',threadId:'thread-1'})).json();
 const response=await f.post('/api/send',{draftId:draft.id});
 assert.equal(response.status,409); assert.match(response.json().error,/five-email limit/); assert.equal(f.calls.sent,0);
});
