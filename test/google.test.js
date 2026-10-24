import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleServices } from '../lib/google.js';

function services() {
  const google = new GoogleServices('.', {}, 8081);
  google.auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'test-token' }) }), getProjectId: async () => 'test-project' };
  return google;
}
test('Vertex generation uses OAuth, selected project and structured email output', async t => {
  const google = services(); let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Hello\nthere', body: 'A kind check-in.' }) }] } }] });
  });
  const draft = await google.generate('Be kind.');
  assert.equal(draft.subject, 'Hello there'); assert.equal(draft.body, 'A kind check-in.');
  assert.match(request.url, /aiplatform.googleapis.com\/v1\/projects\/test-project\/locations\/global/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.contents[0].parts[0].text, 'Be kind.');
});
test('Developer backend uses the developer endpoint with service account OAuth', async t => {
  const google = services(); let endpoint;
  t.mock.method(globalThis, 'fetch', async url => {
    endpoint = url; return Response.json({ candidates: [{ content: { parts: [{ text: '{"subject":"Hi","body":"Hello"}' }] } }] });
  });
  await google.generate('Hi', 'developer');
  assert.match(endpoint, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\//);
});
test('generation reports actionable upstream failures and rejects empty output', async t => {
  const google = services();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Vertex AI API is disabled. Enable it in your Google project.' } }, { status: 403 }));
  await assert.rejects(() => google.generate('Hi'), /Vertex AI API is disabled/);
  fetchMock.mock.mockImplementation(async () => Response.json({ candidates: [] }));
  await assert.rejects(() => google.generate('Hi'), /returned no text/);
  fetchMock.mock.mockImplementation(async () => Response.json({ candidates: [{ content: { parts: [{ text: '{bad json' }] } }] }));
  await assert.rejects(() => google.generate('Hi'), /incomplete email/);
});
test('Gmail sends from the verified account to the recipient fixed in the preview', async t => {
  const google = services(); let payload;
  google.identity = async () => ({ email: 'owner@example.com' });
  google.gmailHeaders = async () => ({ Authorization: 'Bearer test-token' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    payload = JSON.parse(options.body); return Response.json({ id: 'accepted-message' });
  });
  const sent = await google.send({ subject: 'Check-in', body: 'How are you?', to: 'friend@example.com', fromAccount: 'owner@example.com' });
  assert.equal(sent.to, 'friend@example.com'); assert.equal(sent.id, 'accepted-message');
  const mime = Buffer.from(payload.raw, 'base64url').toString();
  assert.match(mime, /From: owner@example.com/); assert.match(mime, /To: friend@example.com/);
});

test('Gemini receives every message as untrusted conversation data', async t => {
  const google = services(); let payload;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    payload = JSON.parse(options.body); return Response.json({ candidates: [{ content: { parts: [{ text: '{"subject":"Reply","body":"Thanks for the details."}' }] } }] });
  });
  await google.generate('Reply kindly', 'vertex', { thread: { messages: [
    { from: 'owner@example.com', body: 'Original detail', attachments: [] },
    { from: 'friend@example.com', body: 'Reply and follow-up detail', attachments: [] },
  ] } });
  assert.equal(payload.contents[0].parts.length, 2);
  assert.match(payload.contents[0].parts[1].text, /all 2 messages/);
  assert.match(payload.contents[0].parts[1].text, /Original detail/);
  assert.match(payload.contents[0].parts[1].text, /Reply and follow-up detail/);
  assert.match(payload.systemInstruction.parts[0].text, /untrusted data/);
});
test('oversized thread context is refused instead of silently truncated', async t => {
  const google = services(); let called = false;
  t.mock.method(globalThis, 'fetch', async () => { called = true; return Response.json({}); });
  await assert.rejects(() => google.generate('Reply', 'vertex', { thread: { messages: [{ body: 'x'.repeat(500001) }] } }), /No messages were omitted/);
  assert.equal(called, false);
});
test('Gmail replies include thread ID and headers, and stale threads cannot send', async t => {
  const google = services(); let payload, sends = 0;
  google.identity = async () => ({ email: 'owner@example.com' });
  google.gmailHeaders = async () => ({ Authorization: 'Bearer test-token' });
  google.getThread = async () => ({ version: 'v1' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    payload = JSON.parse(options.body); sends++; return Response.json({ id: 'reply-id', threadId: 'abc123' });
  });
  const draft = { subject: 'Re: Hello', body: 'Thanks!', to: 'friend@example.com', fromAccount: 'owner@example.com', threadId: 'abc123', threadVersion: 'v1', inReplyTo: '<message@example.com>', references: '<original@example.com> <message@example.com>' };
  const result = await google.send(draft);
  assert.equal(payload.threadId, 'abc123'); assert.equal(result.threadId, 'abc123');
  assert.match(Buffer.from(payload.raw, 'base64url').toString(), /In-Reply-To: <message@example.com>/);
  google.getThread = async () => ({ version: 'v2' });
  await assert.rejects(() => google.send(draft), /New messages arrived/); assert.equal(sends, 1);
  await assert.rejects(() => google.send({ ...draft, fromAccount: 'other@example.com' }), /account changed/); assert.equal(sends, 1);
});
test('full-thread retrieval fetches text body data stored outside the payload', async t => {
  const google = services(); google.gmailHeaders = async () => ({ Authorization: 'Bearer test-token' });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/attachments/')) return Response.json({ data: Buffer.from('Entire text body').toString('base64url') });
    assert.match(url, /threads\/abc123\?format=full$/);
    return Response.json({ id: 'abc123', messages: [{ id: 'm1', payload: { mimeType: 'text/plain', headers: [], body: { attachmentId: 'body-id' } } }] });
  });
  const thread = await google.getThread('abc123'); assert.equal(thread.messages[0].body, 'Entire text body');
});
test('insufficient read scope gives a reconnect instruction', async t => {
  const google = services(); google.gmailHeaders = async () => ({ Authorization: 'Bearer test-token' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Request had insufficient authentication scopes.' } }, { status: 403 }));
  await assert.rejects(() => google.getThread('abc123'), /Reconnect Gmail and approve reading email/);
});

test('Gmail thread summaries distinguish recipient replies from sent messages and drafts',async t=>{
 const google=services();google.store={read:async()=>({email:'owner@example.com'})};google.gmailHeaders=async()=>({Authorization:'Bearer test-token'});
 t.mock.method(globalThis,'fetch',async url=>{
   if(!url.includes('format=metadata'))return Response.json({threads:[{id:'abc123'}]});
   return Response.json({messages:[
    {labelIds:['SENT'],payload:{headers:[{name:'Subject',value:'Profile'},{name:'From',value:'owner@example.com'}]}},
    {labelIds:['INBOX'],payload:{headers:[{name:'Subject',value:'Re: Profile'},{name:'From',value:'Friend <friend@example.com>'}]}},
    {labelIds:['DRAFT'],payload:{headers:[{name:'Subject',value:'Draft'},{name:'From',value:'owner@example.com'}]}},
   ]});
 });
 const result=await google.listThreads();assert.equal(result.threads[0].messageCount,2);assert.equal(result.threads[0].replyCount,1);
});
