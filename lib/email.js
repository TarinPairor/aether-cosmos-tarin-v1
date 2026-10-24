import { convert } from 'html-to-text';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export function validateAddress(value) {
  if (typeof value !== 'string') throw new AppError('Enter one recipient email address.');
  const email = value.trim();
  const [local, domain, extra] = email.split('@');
  if (extra || !local || local.length > 64 || email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new AppError('Enter one valid email address, without a display name, commas, or extra headers.');
  }
  return email;
}
export function addressFromHeader(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new AppError('This message has an unsupported reply address. Start a new email and enter the address.');
  const bracket = value.match(/^[^<>]*<([^<>]+)>\s*$/);
  return validateAddress(bracket ? bracket[1] : value);
}
export function header(payload, name) {
  return payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
export function validateThreadId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,160}$/i.test(id)) throw new AppError('Choose a valid Gmail conversation.');
  return id;
}
function decodePart(part, encoded) {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(header(part, 'content-type'))?.[1] || 'utf-8';
  if (!iconv.encodingExists(charset)) throw new AppError(`Cannot decode message charset ${charset}. No partial thread was sent to Gemini.`);
  return iconv.decode(Buffer.from(encoded || '', 'base64url'), charset);
}
async function partText(part, messageId, attachmentData) {
  if (!part || part.filename || header(part, 'content-disposition').toLowerCase().startsWith('attachment')) return '';
  if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
    const encoded = part.body?.data || (part.body?.attachmentId ? await attachmentData(messageId, part.body.attachmentId) : '');
    const text = decodePart(part, encoded);
    return part.mimeType === 'text/html' ? convert(text, { wordwrap: false, limits: { maxInputLength: Infinity, maxDepth: Infinity, maxChildNodes: Infinity }, selectors: [{ selector: 'img', format: 'skip' }] }) : text;
  }
  const parts = part.parts || [];
  if (part.mimeType === 'multipart/alternative') {
    const preferred = parts.find(p => p.mimeType === 'text/plain' && !p.filename);
    if (preferred) return partText(preferred, messageId, attachmentData);
    const html = parts.find(p => p.mimeType === 'text/html' && !p.filename);
    if (html) return partText(html, messageId, attachmentData);
    for (const child of [...parts].reverse()) {
      const text = await partText(child, messageId, attachmentData);
      if (text) return text;
    }
    return '';
  }
  return (await Promise.all(parts.map(p => partText(p, messageId, attachmentData)))).filter(Boolean).join('\n\n');
}
function attachments(part) {
  return [...(part?.filename ? [part.filename] : []), ...(part?.parts || []).flatMap(attachments)];
}
export async function normalizeThread(raw, attachmentData = async () => { throw new AppError('A message body could not be loaded. Refresh the thread.'); }) {
  const messages = await Promise.all([...(raw.messages || [])].sort((a,b) => Number(a.internalDate || 0) - Number(b.internalDate || 0)).map(async message => ({
    id: message.id, isDraft: message.labelIds?.includes('DRAFT') || false,
    sentByOwner: message.labelIds?.includes('SENT') || message.labelIds?.includes('DRAFT') || false,
    from: header(message.payload, 'From'), to: header(message.payload, 'To'),
    replyTo: header(message.payload, 'Reply-To'), subject: header(message.payload, 'Subject'),
    date: header(message.payload, 'Date'), internalDate: message.internalDate,
    messageId: header(message.payload, 'Message-ID'), references: header(message.payload, 'References'),
    body: await partText(message.payload, message.id, attachmentData), attachments: attachments(message.payload),
  })));
  if (!messages.length) throw new AppError('This Gmail conversation has no messages.');
  return { id: raw.id, subject: messages[0].subject || '(No subject)', messages,
    version: createHash('sha256').update(messages.map(m => m.id).join('\n')).digest('hex') };
}
export function replyEnvelope(thread, ownEmail) {
  const own = ownEmail.toLowerCase();
  const isOwn = message => message.sentByOwner || addressFromHeader(message.from).toLowerCase() === own;
  const latest = [...thread.messages].reverse().find(m => {
    try { return !isOwn(m); } catch { return false; }
  }) || thread.messages.at(-1);
  const fromSelf = isOwn(latest);
  const to = addressFromHeader(fromSelf ? latest.to : latest.replyTo || latest.from);
  if (!/^<[^<>\s]+>$/.test(latest.messageId)) throw new AppError('This message has no valid Message-ID. Start a new email to reply.');
  const references = [...new Set(thread.messages.flatMap(m => [...m.references.matchAll(/<[^<>\s]+>/g)].map(x => x[0]).concat(/^<[^<>\s]+>$/.test(m.messageId) ? [m.messageId] : [])))].join(' ');
  const subject = latest.subject.replace(/[\r\n]/g, ' ');
  if (subject.length > 998) throw new AppError('This thread subject is too long to reply safely. Start a new email.');
  return { to, subject, threadId: thread.id, threadVersion: thread.version, inReplyTo: latest.messageId, references };
}

export function encodeEmail(address, draft) {
  const from = validateAddress(address), to = validateAddress(draft.to || from);
  const chunks = []; let chunk = '';
  for (const character of draft.subject.replace(/[\r\n]/g, ' ')) {
    if (Buffer.byteLength(chunk + character) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const subjectLines = chunks.map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
  const body = Buffer.from(draft.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const replyHeaders = [];
  if (draft.threadId) {
    validateThreadId(draft.threadId);
    if (!/^<[^<>\s]+>$/.test(draft.inReplyTo)) throw new AppError('Invalid reply headers. Generate a fresh reply preview.');
    const refs = (draft.references || draft.inReplyTo).split(' ');
    if (!refs.every(ref => /^<[^<>\s]+>$/.test(ref) && ref.length < 900)) throw new AppError('Invalid References header.');
    replyHeaders.push(`In-Reply-To: ${draft.inReplyTo}`, `References: ${refs.join('\r\n ')}`);
  }
  const sender = draft.fromName ? `=?UTF-8?B?${Buffer.from(String(draft.fromName)).toString('base64')}?= <${from}>` : from;
  return Buffer.from([`From: ${sender}`, `To: ${to}`, `Subject: ${subjectLines}`, ...replyHeaders,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n')).toString('base64url');
}
