import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { normalizeThread, validateAddress, addressFromHeader, replyEnvelope, encodeEmail } from '../lib/email.js';
const b64 = value => Buffer.from(value).toString('base64url');
const headers = (subject, from, messageId, extra = []) => [
  { name: 'Subject', value: subject }, { name: 'From', value: from }, { name: 'To', value: 'owner@example.com' },
  { name: 'Message-ID', value: messageId }, ...extra,
];
test('reads every message in chronological order and chooses plain text over HTML alternatives', async () => {
  const thread = await normalizeThread({ id: 'abc123', messages: [
    { id: 'second', internalDate: '20', payload: { mimeType: 'multipart/alternative', headers: headers('Re: Hello', 'friend@example.com', '<b@example.com>'), parts: [
      { mimeType: 'text/plain', body: { data: b64('Complete plain text reply') } },
      { mimeType: 'text/html', body: { data: b64('<p>Duplicate HTML reply</p>') } },
    ] } },
    { id: 'first', internalDate: '10', payload: { mimeType: 'text/plain', headers: headers('Hello', 'owner@example.com', '<a@example.com>'), body: { data: b64('Original message with full detail') } } },
  ] });
  assert.equal(thread.messages.length, 2); assert.equal(thread.messages[0].id, 'first');
  assert.equal(thread.messages[0].body, 'Original message with full detail');
  assert.equal(thread.messages[1].body, 'Complete plain text reply');
  assert.equal(thread.version.length, 64);
});
test('converts HTML-only messages to text and excludes attachment bodies', async () => {
  const thread = await normalizeThread({ id: 'abc123', messages: [{ id: 'a', payload: { mimeType: 'multipart/mixed', headers: [], parts: [
    { mimeType: 'text/html', body: { data: b64('<p>Hello &amp; welcome.</p><script>ignore()</script><img src="https://example.com/track">') } },
    { filename: 'private.txt', mimeType: 'text/plain', body: { data: b64('attachment secret') } },
  ] } }] });
  assert.match(thread.messages[0].body, /Hello & welcome\./);
  assert.doesNotMatch(thread.messages[0].body, /ignore|track|attachment secret/);
  assert.deepEqual(thread.messages[0].attachments, ['private.txt']);
});
test('loads externally stored text body data and honors declared charset', async () => {
  let loaded = false;
  const thread = await normalizeThread({ id: 'abc123', messages: [{ id: 'a', payload: {
    mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1252' }], body: { attachmentId: 'body-attachment' },
  } }] }, async (message, attachment) => { assert.equal(message, 'a'); assert.equal(attachment, 'body-attachment'); loaded = true; return iconv.encode('Café — hello', 'windows-1252').toString('base64url'); });
  assert.equal(loaded, true); assert.equal(thread.messages[0].body, 'Café — hello');
});
test('validates single recipients and rejects injected or multiple addresses', () => {
  assert.equal(validateAddress('friend+test@example.com'), 'friend+test@example.com');
  assert.equal(addressFromHeader('A Friend <friend@example.com>'), 'friend@example.com');
  for (const value of ['a@example.com\r\nBcc: b@example.com', 'a@example.com,b@example.com', 'a@example.com; b@example.com', 'A <a@example.com>', '.a@example.com', 'a@-example.com']) assert.throws(() => validateAddress(value));
});
test('reply envelope respects Reply-To and preserves complete reference chain', () => {
  const thread = { id: 'abc123', version: 'v1', messages: [
    { from: 'owner@example.com', to: 'friend@example.com', subject: 'Hello', messageId: '<a@example.com>', references: '' },
    { from: 'Friend <friend@example.com>', to: 'owner@example.com', replyTo: 'reply@example.com', subject: 'Re: Hello', messageId: '<b@example.com>', references: '<a@example.com>' },
  ] };
  const envelope = replyEnvelope(thread, 'owner@example.com');
  assert.equal(envelope.to, 'reply@example.com'); assert.equal(envelope.subject, 'Re: Hello');
  assert.equal(envelope.inReplyTo, '<b@example.com>'); assert.equal(envelope.references, '<a@example.com> <b@example.com>');
  const mime = Buffer.from(encodeEmail('owner@example.com', { ...envelope, body: 'My reply' }), 'base64url').toString();
  assert.match(mime, /In-Reply-To: <b@example.com>/); assert.match(mime, /References: <a@example.com>\r\n <b@example.com>/);
  thread.messages[1].messageId = '<b@example.com>\r\nBcc: evil@example.com'; assert.throws(() => replyEnvelope(thread, 'owner@example.com'));
});
test('outbound-only threads reply to the prior recipient rather than the sender', () => {
  const envelope = replyEnvelope({ id: 'abc123', version: 'v1', messages: [
    { from: 'owner@example.com', to: 'friend@example.com', subject: 'Hello', messageId: '<a@example.com>', references: '' },
  ] }, 'owner@example.com');
  assert.equal(envelope.to, 'friend@example.com');
});
test('folded MIME subjects preserve Unicode code points', () => {
  const subject = 'A long 🌿 subject café '.repeat(10);
  const mime = Buffer.from(encodeEmail('owner@example.com', { to: 'friend@example.com', subject, body: 'Hi' }), 'base64url').toString();
  const encoded = mime.match(/Subject: ([\s\S]*?)\r\nMIME-Version:/)[1];
  const decoded = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m => Buffer.from(m[1], 'base64').toString()).join('');
  assert.equal(decoded, subject);
});

test('Gmail SENT metadata identifies self-sent aliases and avoids replying to the owner', async () => {
  const thread = await normalizeThread({ id: 'abc123', messages: [
    { id: 'incoming', internalDate: '10', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: headers('Hello', 'friend@example.com', '<a@example.com>'), body: { data: b64('Hello there') } } },
    { id: 'outgoing', internalDate: '20', labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: headers('Re: Hello', 'Owner Alias <alias@example.org>', '<b@example.com>'), body: { data: b64('My previous reply') } } },
  ] });
  assert.equal(thread.messages[1].sentByOwner, true);
  const envelope = replyEnvelope(thread, 'owner@example.com');
  assert.equal(envelope.to, 'friend@example.com'); assert.equal(envelope.inReplyTo, '<a@example.com>');
});
