import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { validateAddress, addressFromHeader, replyEnvelope } from './email.js';
import { answerFields, FIELDS, MAX_EMAILS, missingFields } from './intake-fields.js';

export const INTAKE_STYLE = `You are Cosmos, a warm, considerate assistant having a natural email conversation to help the recipient complete their profile. Introduce yourself honestly as an assistant in the opening email and say you are collecting their details for a profile spreadsheet. Sound interested, calm, and human in style, without pretending to be a human. Acknowledge what they said, ask a small coherent group of missing details (around 4–5 at a time), and avoid a questionnaire dump. Do not repeat known or declined questions. Let them skip anything. Never infer gender, nationality, marital status, date of birth, or any other unknown personal fact. Ask for clarification on ambiguous dates or contradictions. Stop if they ask to stop. Sign your messages Cosmos. There are at most five outgoing emails including the opening; do not promise further follow-ups beyond that limit.`;

const normalized = value => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fieldKind = field => {
  const name = String(field).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name === 'age' || name.endsWith('age')) return 'age';
  if (name.includes('phone') || name.includes('mobile')) return 'phone';
  if (name === 'dob' || name.includes('dateofbirth') || name.includes('birthdate')) return 'dob';
  return '';
};
export function authoredText(body) {
  return body.split(/\n(?:On [^\n]{0,250}wrote:|[- ]*Original Message[- ]*|From:[^\n]*\nSent:)/i)[0].split('\n').filter(line => !/^\s*>/.test(line)).join('\n').trim();
}
function supportedValue(field, value, quote) {
  if (value === 'Not applicable') return /\b(not applicable|n\/a|none|no company|no department|don.t have|do not have)\b/i.test(quote);
  if (fieldKind(field) === 'phone') {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 5 && quote.replace(/\D/g, '').includes(digits);
  }
  if (fieldKind(field) === 'dob') {
    if (quote.includes(value)) return true;
    const first = quote.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)[ ,]+(\d{4})\b/i);
    const second = quote.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[ ,]+(\d{4})\b/i);
    const month = (first?.[2] || second?.[1] || '').slice(0,3).toLowerCase();
    const index = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month);
    const day = first?.[1] || second?.[2], year = first?.[3] || second?.[3];
    return index >= 0 && `${year}-${String(index+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` === value;
  }
  return (` ${normalized(quote)} `).includes(` ${normalized(value)} `);
}

export function applyFacts(session, plan, incoming) {
  const source = new Map(incoming.map(message => [message.id, message]));
  const profile = { ...session.profile }, evidence = { ...session.evidence };
  const invalidDropdownFields = new Set();
  for (const fact of Array.isArray(plan.facts) ? plan.facts : []) {
    if (!fact || !(session.answerFields || answerFields(session.fields || FIELDS)).includes(fact.field)) continue;
    const message = source.get(fact.messageId);
    if (!message || typeof fact.evidence !== 'string' || !fact.evidence.trim() || !message.body.includes(fact.evidence)) continue;
    const value = fact.declined === true ? 'Declined' : typeof fact.value === 'string' ? fact.value.trim() : '';
    if (!value || value.length > 1000) continue;
    if (fact.declined === true && !/prefer not|rather not|decline|skip|private|not share|won.t share|do not want|don.t want/i.test(fact.evidence)) continue;
    const choices = session.dropdownOptions?.[fact.field];
    if (choices && fact.declined !== true && !choices.includes(value)) { invalidDropdownFields.add(fact.field); continue; }
    if (!choices && fact.declined !== true && !supportedValue(fact.field, value, fact.evidence)) continue;
    if (!choices && fieldKind(fact.field) === 'age' && value !== 'Declined' && value !== 'Not applicable' && (!/^\d{1,3}$/.test(value) || Number(value) > 130)) continue;
    if (!choices && fieldKind(fact.field) === 'dob' && !['Declined', 'Not applicable'].includes(value)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value || Date.parse(value) > Date.now()) continue;
    }
    profile[fact.field] = value;
    evidence[fact.field] = { messageId: fact.messageId, quote: fact.evidence };
  }
  const stopSource = source.get(plan.stopMessageId);
  const stop = plan.stopRequested === true && stopSource && typeof plan.stopEvidence === 'string' && plan.stopEvidence.trim() && stopSource.body.includes(plan.stopEvidence);
  return { profile, evidence, stop: Boolean(stop), invalidDropdownFields: [...invalidDropdownFields] };
}
function validPlan(plan) {
  if (!plan || typeof plan.subject !== 'string' || typeof plan.body !== 'string' || !plan.body.trim() || plan.body.length > 15000) throw new AppError('The intake model returned an invalid email. No email was sent.');
  return plan;
}
function recipientMessages(session, thread) {
  return thread.messages.filter(message => {
    if (message.isDraft || session.sentMessageIds.includes(message.id)) return false;
    try { return (session.correspondentEmails || [session.email]).some(email => email.toLowerCase() === addressFromHeader(message.from).toLowerCase()); } catch { return false; }
  }).map(message => ({ ...message, body: authoredText(message.body) }));
}
function envelope(thread, latest) {
  if (!/^<[^<>\s]+>$/.test(latest.messageId)) throw new AppError('The recipient reply has no valid Message-ID. Start a new intake thread.');
  return { threadId: thread.id, threadVersion: thread.version, subject: latest.subject.replace(/[\r\n]/g, ' '),
    inReplyTo: latest.messageId, references: thread.messages.map(m => m.messageId).filter(id => /^<[^<>\s]+>$/.test(id)).join(' ') };
}
export class IntakeService {
  constructor({ store, google, sheets }) { this.store = store; this.google = google; this.sheets = sheets; }
  async list() { return await this.store.read('intakes', []); }
  async save(session) {
    const records = await this.list(), index = records.findIndex(record => record.id === session.id);
    if (index === -1) records.unshift(session); else records[index] = session;
    await this.store.write('intakes', records);
  }
  async get(id) {
    const session = (await this.list()).find(record => record.id === id);
    if (!session) throw new AppError('This intake was not found.', 404);
    return session;
  }
  async prepare(email, previousId = null, { autoReply = false } = {}) {
    email = validateAddress(email);
    const owner = (await this.google.identity()).email;
    await this.google.checkReadAccess();
    const records = await this.list();
    if (records.some(s => s.owner === owner && s.email.toLowerCase() === email.toLowerCase() && (s.optedOutAt || s.status === 'stopped'))) throw new AppError('This recipient asked to stop. Automated intake will not restart.');
    const previous = previousId ? await this.get(previousId) : null;
    if (previous && (previous.email.toLowerCase() !== email.toLowerCase() || previous.owner !== owner)) throw new AppError('The new thread must belong to the same recipient and connected account.');
    if (records.some(s => s.owner === owner && s.email.toLowerCase() === email.toLowerCase() && ['ready', 'waiting', 'reply_ready', 'followup_ready', 'sending'].includes(s.status))) throw new AppError('This recipient already has an active intake. Open that thread to continue.');
    const sheetConfig = this.sheets.config?.();
    const existing = await this.sheets.lookup(email, sheetConfig);
    const fields = existing.fields || [];
    if (!fields.length) throw new AppError('Could not read field names from row 1 of the spreadsheet.');
    const answerFieldsForSession = answerFields(fields);
    const profile = { ...(previous?.profile || {}), ...Object.fromEntries(Object.entries(existing.profile).filter(([,v]) => v !== '')) };
    if (fields.includes('Person ID')) profile['Person ID'] ||= randomUUID(); profile.Email = email;
    if (!missingFields(profile, fields).length) throw new AppError('This person’s profile is already complete. No further intake email is needed.');
    const session = { id: randomUUID(), owner, email, profile, fields, dropdownOptions: existing.dropdownOptions || {}, ...(sheetConfig ? { sheetConfig } : {}), answerFields: answerFieldsForSession, evidence: previous?.evidence || {}, status: 'ready', sentCount: 0,
      sentMessageIds: [], processedIncoming: [], threadId: null, autoReply, replyCount: 0, messageCount: 0, previousId, createdAt: new Date().toISOString(), sheetRow: existing.row };
    const plan = validPlan(await this.google.planIntake({ session, incoming: [], thread: null, style: INTAKE_STYLE }));
    session.pendingDraft = { id: randomUUID(), subject: `A hello from Cosmos · ${session.id.slice(0,8)}`, body: plan.body, to: email, fromAccount: owner, fromName: 'Cosmos' };
    await this.save(session);
    return session;
  }
  async sync(session) {
    const result = await this.sheets.upsert(session.profile, session.sheetConfig);
    session.sheetRow = result.row; session.sheetUrl = result.url; session.syncPending = false; session.syncedAt = new Date().toISOString();
    await this.save(session);
  }
  async owned(id) {
    const session = await this.get(id), account = await this.store.read('gmail-account');
    if (!account || account.email !== session.owner) throw new AppError('Connect the Gmail account that owns this thread.', 403);
    return session;
  }
  async importConversation(threadId) {
    const owner = (await this.google.identity()).email;
    const records = await this.list();
    const existing = records.find(s => s.owner === owner && s.threadId === threadId);
    if (existing) return existing;
    const thread = await this.google.getThread(threadId), email = replyEnvelope(thread, owner).to;
    if (records.some(s => s.owner === owner && s.email.toLowerCase() === email.toLowerCase() && (s.optedOutAt || s.status === 'stopped'))) throw new AppError('This recipient asked to stop. This conversation cannot restart intake.');
    if (records.some(s => s.owner === owner && s.email.toLowerCase() === email.toLowerCase() && ['ready','waiting','reply_ready','followup_ready','sending'].includes(s.status))) throw new AppError('This person already has an active profile thread. Select that thread in the dashboard.');
    const sheetConfig = this.sheets.config?.();
    const { profile: saved, row, fields, dropdownOptions } = await this.sheets.lookup(email, sheetConfig);
    const correspondent = [...thread.messages].reverse().find(message => {
      if (message.isDraft || message.sentByOwner) return false;
      try { return addressFromHeader(message.from).toLowerCase() !== owner.toLowerCase(); } catch { return false; }
    });
    const correspondentEmails = [...new Set([email, ...(correspondent ? [addressFromHeader(correspondent.from)] : [])])];
    const sent = thread.messages.filter(m => !m.isDraft && (m.sentByOwner || (() => { try { return addressFromHeader(m.from).toLowerCase() === owner.toLowerCase(); } catch { return false; } })()));
    const activeFields = fields || Object.keys(saved);
    const profile = { ...saved, ...(activeFields.includes('Person ID') ? { 'Person ID': saved['Person ID'] || randomUUID() } : {}), Email: email };
    const session = { id: randomUUID(), owner, email, profile, fields: activeFields, dropdownOptions: dropdownOptions || {}, ...(sheetConfig ? { sheetConfig } : {}), answerFields: answerFields(activeFields), evidence: {}, status: sent.length >= MAX_EMAILS ? 'limit_reached' : 'waiting',
      sentCount: sent.length, sentMessageIds: sent.map(m => m.id), processedIncoming: [], threadId, autoReply: false,
      createdAt: new Date().toISOString(), sheetRow: row, messageCount: thread.messages.filter(m => !m.isDraft).length, imported: true, correspondentEmails };
    session.replyCount = recipientMessages(session, thread).length;
    await this.save(session); return session;
  }
  async conversation(id) {
    const session = await this.owned(id);
    const thread = session.threadId ? await this.google.getThread(session.threadId) : null;
    if (thread) {
      session.replyCount = recipientMessages(session, thread).length;
      session.messageCount = thread.messages.filter(message => !message.isDraft).length;
    }
    if (session.pendingDraft && !session.pendingDraft.id) session.pendingDraft.id = randomUUID();
    await this.save(session);
    return { session, thread };
  }
  async generateIntro(id) {
    const session = await this.owned(id);
    if (session.sentCount !== 0 || session.threadId || session.status !== 'ready') throw new AppError('The introduction has already been sent. Use Generate reply for this thread.');
    const plan = validPlan(await this.google.planIntake({ session, incoming: [], thread: null, style: INTAKE_STYLE }));
    session.pendingDraft = { ...session.pendingDraft, id: randomUUID(), body: plan.body };
    await this.save(session); return session;
  }
  async generateReply(id) {
    const session = await this.owned(id);
    if (!session.threadId) throw new AppError('Send the introduction before generating a reply.');
    if (session.sentCount >= MAX_EMAILS) throw new AppError('Five emails have been sent. Start a new thread to continue.');
    if (!['waiting','reply_ready','followup_ready'].includes(session.status)) throw new AppError('Resume this thread before generating a reply. Completed or stopped threads cannot continue.');
    if (session.autoReply === true) throw new AppError('Turn off automatic replies to review and send a reply yourself.');
    await this.process(session, { allowSend: false });
    if (['complete','stopped','limit_reached'].includes(session.status)) return session;
    const thread = await this.google.getThread(session.threadId);
    if (!session.pendingDraft || session.pendingDraft.threadVersion !== thread.version) {
      const latest = thread.messages.filter(message => !message.isDraft).at(-1);
      if (!latest) throw new AppError('This conversation has no sent messages to continue.');
      const plan = validPlan(await this.google.planIntake({ session, incoming: [], thread, style: INTAKE_STYLE, continuation: true }));
      session.pendingDraft = { id: randomUUID(), ...envelope(thread, latest), body: plan.body, to: session.email, fromAccount: session.owner, fromName: 'Cosmos', proactive: true };
      session.status = 'reply_ready';
      await this.save(session);
    }
    return session;
  }
  async sendPreview(id, draftId) {
    const session = await this.owned(id);
    if (!draftId || session.pendingDraft?.id !== draftId) throw new AppError('This preview changed. Reload the thread and review the latest preview before sending.', 409);
    if (session.status === 'ready') return this.start(id);
    if (!['reply_ready','followup_ready'].includes(session.status)) throw new AppError('Generate a reply preview before sending.', 409);
    const thread = await this.google.getThread(session.threadId);
    if (thread.version !== session.pendingDraft.threadVersion) {
      await this.process(session, { allowSend: false });
      if (session.pendingDraft && session.pendingDraft.threadVersion !== thread.version) {
        session.pendingDraft = null; session.status = 'waiting'; await this.save(session);
      }
      throw new AppError('New messages arrived. Generate or review the updated reply preview before sending.', 409);
    }
    if (session.syncPending || !session.sheetRow) await this.sync(session);
    await this.send(session); return session;
  }
  async automation(id, enabled) {
    const session = await this.owned(id);
    if (['complete','stopped','send_uncertain','archived','sending'].includes(session.status) || session.optedOutAt) throw new AppError('Automatic replies cannot be changed for this thread.');
    session.autoReply = enabled === true;
    await this.save(session); return session;
  }
  async send(session) {
    if ((await this.list()).some(s => s.owner === session.owner && s.email.toLowerCase() === session.email.toLowerCase() && (s.optedOutAt || s.status === 'stopped'))) throw new AppError('This recipient asked to stop. No further intake email will be sent.');
    if (session.sentCount >= MAX_EMAILS) { session.status = 'limit_reached'; session.pendingDraft = null; await this.save(session); return; }
    if (!session.pendingDraft) throw new AppError('Generate an intake preview first.');
    if ((await this.google.identity()).email !== session.owner) throw new AppError('Reconnect the Gmail account that owns this intake.');
    const draft = { ...session.pendingDraft, to: session.email, fromAccount: session.owner, fromName: 'Cosmos' };
    session.sentCount++; session.status = 'sending'; session.sendAttemptAt = new Date().toISOString();
    await this.save(session); // Reserve quota before contacting Gmail; uncertain sends are never retried.
    try {
      const result = await this.google.send(draft);
      if (!result.threadId) throw new AppError('Gmail did not return a thread ID. Check Sent before starting a new thread.');
      session.threadId = result.threadId; session.sentMessageIds.push(result.id); session.pendingDraft = null;
      session.messageCount = (session.messageCount || 0) + 1;
      session.status = session.sentCount >= MAX_EMAILS ? 'limit_reached' : 'waiting'; session.error = null;
      await this.save(session);
    } catch (error) {
      session.status = 'send_uncertain'; session.error = 'Send could not be confirmed. Check Gmail Sent. This attempt counts toward the five-email limit and will not be retried.';
      await this.save(session); throw error;
    }
  }
  async start(id) {
    const session = await this.get(id);
    if (session.status !== 'ready') throw new AppError('This opening email was already started.');
    await this.sync(session); // Do not start emailing until the spreadsheet write actually succeeds.
    await this.send(session);
    if (session.previousId) { const old = await this.get(session.previousId); old.status = 'archived'; await this.save(old); }
    return session;
  }
  async control(id, action) {
    const session = await this.get(id);
    if (action === 'pause') {
      if (['ready', 'waiting', 'reply_ready', 'followup_ready', 'error'].includes(session.status)) { session.resumeStatus = session.status === 'error' ? session.resumeStatus || 'waiting' : session.status; session.status = 'paused'; }
    } else if (action === 'resume' && ['paused', 'error'].includes(session.status)) {
      if ((await this.google.identity()).email !== session.owner) throw new AppError('Reconnect the Gmail account that owns this intake.');
      if ((await this.list()).some(other => other.id !== id && other.owner === session.owner && other.email.toLowerCase() === session.email.toLowerCase() && ['ready', 'waiting', 'reply_ready', 'followup_ready', 'sending'].includes(other.status))) throw new AppError('This recipient already has another active intake thread.');
      if (session.syncPending) await this.sync(session);
      if (session.optedOutAt || (await this.list()).some(s => s.owner === session.owner && s.email.toLowerCase() === session.email.toLowerCase() && (s.optedOutAt || s.status === 'stopped'))) {
        session.status = 'stopped'; session.pendingDraft = null; session.error = null; await this.save(session); return session;
      }
      session.status = session.resumeStatus || 'waiting'; session.error = null;
    } else throw new AppError('This intake cannot be resumed. For a capped or uncertain thread, explicitly prepare a new thread.');
    await this.save(session); return session;
  }
  async poll() {
    const account = await this.store.read('gmail-account');
    if (!account) return;
    for (const session of await this.list()) {
      if (session.owner !== account.email) continue;
      const terminal = ['complete','stopped'].includes(session.status) ? session.status : session.status === 'error' && ['complete','stopped'].includes(session.resumeStatus) ? session.resumeStatus : null;
      if (terminal && session.syncPending) {
        try { await this.sync(session); session.status = session.optedOutAt ? 'stopped' : terminal; session.error = null; await this.save(session); }
        catch (error) { session.error = error instanceof AppError ? error.message : 'Spreadsheet sync is pending. No further email will be sent. The app will retry saving.'; await this.save(session); }
        continue;
      }
      if (!['waiting', 'reply_ready', 'limit_reached', 'followup_ready', 'sending'].includes(session.status)) continue;
      if (session.status === 'sending') { session.status = 'send_uncertain'; session.error = 'The app stopped during a send. Check Gmail Sent. No automatic retry will occur.'; await this.save(session); continue; }
      try { await this.process(session); }
      catch (error) {
        if (session.status !== 'send_uncertain') { session.resumeStatus = session.status; if (!['complete','stopped'].includes(session.status)) session.status = 'error'; session.error = error instanceof AppError ? error.message : 'Intake connection failed. Check Google connections, then resume.'; await this.save(session); }
      }
    }
  }
  async process(session, { allowSend = true } = {}) {
    if (session.syncPending) await this.sync(session);
    const thread = await this.google.getThread(session.threadId);
    const replyCount = recipientMessages(session, thread).length;
    const messageCount = thread.messages.filter(message => !message.isDraft).length;
    if (replyCount !== session.replyCount || messageCount !== session.messageCount) { session.replyCount = replyCount; session.messageCount = messageCount; await this.save(session); }
    const incoming = recipientMessages(session, thread).filter(message => !session.processedIncoming.includes(message.id));
    if (!incoming.length) {
      if (session.pendingDraft && ['reply_ready','followup_ready'].includes(session.status)) {
        if (session.autoReply === true && allowSend && !session.pendingDraft.proactive) await this.send(session);
        else if (session.status !== 'reply_ready') { session.status = 'reply_ready'; await this.save(session); }
      }
      return;
    }
    const plan = validPlan(await this.google.planIntake({ session, incoming, thread, style: INTAKE_STYLE }));
    const result = applyFacts(session, plan, incoming);
    if (result.stop) session.optedOutAt = new Date().toISOString();
    session.profile = result.profile; session.evidence = result.evidence; session.processedIncoming.push(...incoming.map(m => m.id));
    session.syncPending = true; session.lastReplyAt = new Date().toISOString();
    session.status = result.stop ? 'stopped' : !missingFields(session.profile, session.fields).length ? 'complete' : session.sentCount >= MAX_EMAILS ? 'limit_reached' : 'reply_ready';
    const dropdownReminder = result.invalidDropdownFields.map(field => `For ${field}, please choose one of these spreadsheet options: ${session.dropdownOptions[field].join(', ')}.`).join('\n\n');
    session.pendingDraft = session.status === 'reply_ready' ? { id: randomUUID(), ...envelope(thread, incoming.at(-1)), body: [plan.body, dropdownReminder].filter(Boolean).join('\n\n'), to: session.email, fromAccount: session.owner, fromName: 'Cosmos' } : null;
    await this.save(session); await this.sync(session);
    if (session.status === 'reply_ready' && session.autoReply === true && allowSend) await this.send(session);
  }
}
