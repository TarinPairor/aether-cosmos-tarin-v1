import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './google.js';
import { validateAddress, validateThreadId, replyEnvelope } from './email.js';
import { FIELDS, MAX_EMAILS } from './intake-fields.js';

export const DEFAULT_PROMPT = 'Write a warm, natural introduction from Cosmos, an assistant helping collect profile details. Ask a small group of clear questions, let the recipient skip anything, and avoid guessing personal information.';
export function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new AppError('Enter a message instruction between 1 and 12,000 characters.');
  return value.trim();
}
export function validateInterval(value) {
  if (!Number.isInteger(value) || value < 5 || value > 43200) throw new AppError('Choose an interval between 5 minutes and 30 days.');
  return value;
}
export function createApp({ root, store, google, intake = null, port = 8081 }) {
  const csrf = randomBytes(32).toString('hex');
  const states = new Map();
  let busy = false;
  let scheduleBusy = false;
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const history = async entry => {
    const entries = await store.read('history', []);
    await store.write('history', [{ at: new Date().toISOString(), ...entry }, ...entries].slice(0, 100));
  };
  async function exclusive(fn) {
    if (busy) throw new AppError('An email operation is already running. Please wait.', 409);
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function tick() {
    if (scheduleBusy || busy) return;
    scheduleBusy = true;
    try {
      if (intake) { await exclusive(() => intake.poll()); return; }
      const config = await store.read('schedule');
      if (!config?.enabled || Date.parse(config.nextRunAt) > Date.now()) return;
      // Claim before sending. On interruption, prefer a missed check-in to duplicate mail.
      config.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
      await store.write('schedule', config);
      try {
        await exclusive(async () => {
          const draft = await google.generate(config.prompt);
          const sent = await google.send(draft);
          await history({ type: 'sent', source: 'schedule', subject: draft.subject, ...sent });
        });
      } catch (error) {
        config.enabled = false;
        config.error = safeError(error);
        await store.write('schedule', config);
        await history({ type: 'error', source: 'schedule', message: safeError(error) });
      }
    } finally { scheduleBusy = false; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(req.headers.host)) throw new AppError('Use localhost to access this app.', 403);
      const url = new URL(req.url, `http://localhost:${port}`);
      if (req.method === 'POST') {
        if (!origins.has(req.headers.origin) || req.headers['x-csrf-token'] !== csrf) throw new AppError('Refresh this page and try again.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Expected a JSON request.', 415);
      }
      if (url.pathname === '/oauth/start' && req.method === 'GET') {
        if (req.headers.host !== `localhost:${port}`) {
          res.writeHead(302, { Location: `http://localhost:${port}/oauth/start` }); return res.end();
        }
        const nonce = randomBytes(32).toString('hex');
        const state = randomBytes(32).toString('hex');
        const verifier = randomBytes(48).toString('base64url');
        for (const [key, value] of states) if (value.expires < Date.now()) states.delete(key);
        states.set(state, { nonce, verifier, expires: Date.now() + 600000 });
        res.setHeader('Set-Cookie', `oauth_nonce=${nonce}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600`);
        res.writeHead(302, { Location: google.authUrl(state, createHash('sha256').update(verifier).digest('base64url')) });
        return res.end();
      }
      if (url.pathname === '/oauth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state');
        const attempt = states.get(state);
        states.delete(state);
        const nonce = req.headers.cookie?.split('; ').find(c => c.startsWith('oauth_nonce='))?.slice(12);
        if (!attempt || attempt.expires < Date.now() || !nonce || nonce.length !== attempt.nonce.length || !timingSafeEqual(Buffer.from(nonce), Buffer.from(attempt.nonce))) {
          throw new AppError('Sign-in expired or started in another browser. Return to the app and connect Gmail again.');
        }
        res.setHeader('Set-Cookie', 'oauth_nonce=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0');
        if (url.searchParams.has('error')) throw new AppError('Gmail access was declined. Return to the app to try again.');
        const code = url.searchParams.get('code');
        if (!code) throw new AppError('Google did not return an authorization code.');
        await google.connect(code, attempt.verifier);
        res.writeHead(302, { Location: '/?connected=1' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, { csrf, busy, serviceAccountFound: google.hasService, oauthFound: google.hasOAuth,
          oauthKind: google.oauthKind, redirectUri: google.redirect, redirectConfigured: google.redirectConfigured,
          model: google.model, backend: google.backend, account: await store.read('gmail-account'),
          canReadThreads: await google.canReadThreads(),
          intakeMode: Boolean(intake), intakes: intake ? await intake.list() : [], intakeFields: intake ? ((await intake.list())[0]?.fields || FIELDS) : FIELDS, intakeMaxEmails: MAX_EMAILS,
          sheet: intake ? { url: `https://docs.google.com/spreadsheets/d/${intake.sheets.id}/edit#gid=${intake.sheets.gid}` } : null,
          draft: await store.read('draft'), schedule: await store.read('schedule'), history: await store.read('history', []),
          diagnostics: await store.read('diagnostics'), defaultPrompt: DEFAULT_PROMPT });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 50000) throw new AppError('Request is too large.', 413); }
        let data; try { data = JSON.parse(body); } catch { throw new AppError('Invalid JSON.'); }
        if (!data || Array.isArray(data) || typeof data !== 'object') throw new AppError('Expected a JSON object.');
        if (url.pathname.startsWith('/api/intake/')) {
          if (!intake) throw new AppError('Intake mode is unavailable.', 404);
          const result = await exclusive(async () => {
            if (url.pathname === '/api/intake/check-sheet') return { sheet: await intake.sheets.inspect() };
            if (url.pathname === '/api/intake/connect-sheet') return { sheet: await intake.sheets.connect(data.url) };
            if (url.pathname === '/api/intake/preview') return { session: await intake.prepare(data.email, data.previousId || null, { autoReply: data.autoReply === true }) };
            if (url.pathname === '/api/intake/thread') return intake.conversation(data.id);
            if (url.pathname === '/api/intake/import') return { session: await intake.importConversation(validateThreadId(data.threadId)) };
            if (url.pathname === '/api/intake/generate-intro') return { session: await intake.generateIntro(data.id) };
            if (url.pathname === '/api/intake/generate-reply') return { session: await intake.generateReply(data.id) };
            if (url.pathname === '/api/intake/send-preview') return { session: await intake.sendPreview(data.id, data.draftId) };
            if (url.pathname === '/api/intake/automation') return { session: await intake.automation(data.id, data.enabled) };
            if (url.pathname === '/api/intake/start') return { session: await intake.start(data.id) };
            if (url.pathname === '/api/intake/control') return { session: await intake.control(data.id, data.action) };
            throw new AppError('Unknown intake action.', 404);
          });
          return json(res, result);
        }
        if (url.pathname === '/api/threads') {
          const query = data.query ?? '', pageToken = data.pageToken ?? '';
          if (typeof query !== 'string' || query.length > 500 || typeof pageToken !== 'string' || pageToken.length > 2000) throw new AppError('Enter a Gmail search under 500 characters.');
          return json(res, await google.listThreads(query, pageToken));
        }
        if (url.pathname === '/api/thread') {
          const thread = await google.getThread(validateThreadId(data.id));
          const account = await store.read('gmail-account');
          if (account?.email) {
            try { thread.replyRecipient = replyEnvelope(thread, account.email).to; }
            catch (error) { thread.replyError = safeError(error); }
          }
          return json(res, { thread });
        }
        if (url.pathname === '/api/generate') {
          const prompt = validatePrompt(data.prompt);
          const draft = await exclusive(async () => {
            const account = await store.read('gmail-account');
            let thread, envelope = {}, fromAccount = account?.email || null;
            const to = data.to ? validateAddress(data.to) : account?.email || null;
            if (data.threadId) {
              thread = await google.getThread(validateThreadId(data.threadId));
              const identity = await google.identity();
              fromAccount = identity.email;
              envelope = replyEnvelope(thread, identity.email);
              if (data.to && to.toLowerCase() !== envelope.to.toLowerCase()) throw new AppError('Reply recipients come from the thread. Start a new email to choose a different address.');
            }
            const content = await google.generate(prompt, google.backend, { thread });
            const draft = { ...content, to, ...envelope, fromAccount,
              contextMessageCount: thread?.messages.length || 0,
              id: randomBytes(16).toString('hex'), prompt, createdAt: new Date().toISOString() };
            await store.write('draft', draft);
            return draft;
          });
          return json(res, { draft });
        }
        if (url.pathname === '/api/send') {
          const sent = await exclusive(async () => {
            const draft = await store.read('draft');
            if (!draft || draft.id !== data.draftId || draft.sentAt || draft.sendingAt) throw new AppError('Generate a fresh preview before sending. This email may already have been sent.', 409);
            if (intake && draft.threadId && (await intake.list()).some(session => session.threadId === draft.threadId)) throw new AppError('Cosmos manages this intake thread and its five-email limit. Use the intake controls instead of sending a separate reply.', 409);
            // Persist intent before the API call to prevent duplicate sends after ambiguous failures.
            draft.sendingAt = new Date().toISOString(); await store.write('draft', draft);
            try {
              const result = await google.send(draft);
              draft.sentAt = new Date().toISOString(); await store.write('draft', draft);
              await history({ type: 'sent', source: 'manual', subject: draft.subject, ...result });
              return result;
            } catch (error) {
              await history({ type: 'error', source: 'manual', message: safeError(error) });
              throw error;
            }
          });
          return json(res, { sent });
        }
        if (url.pathname === '/api/schedule') {
          if (intake && data.enabled === true) throw new AppError('Random check-ins have been replaced by reply-driven intake conversations. Use Start intake.');
          if (scheduleBusy || busy) throw new AppError('Wait for the current operation before changing the schedule.', 409);
          const enabled = data.enabled === true;
          if (!enabled) {
            const previous = await store.read('schedule', { prompt: DEFAULT_PROMPT, intervalMinutes: 1440 });
            const config = { ...(previous || {}), enabled: false };
            await store.write('schedule', config);
            return json(res, { schedule: config });
          }
          const config = { enabled, prompt: validatePrompt(data.prompt), intervalMinutes: validateInterval(data.intervalMinutes) };
          if (enabled) {
            await google.identity();
            const diagnostics = await store.read('diagnostics');
            if (!diagnostics?.gemini?.ok) throw new AppError('Run connection tests successfully before enabling scheduled emails.', 409);
            config.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
          }
          await store.write('schedule', config); return json(res, { schedule: config });
        }
        if (url.pathname === '/api/diagnose') {
          const results = await exclusive(async () => {
            const settled = await Promise.allSettled([
              google.generate('Write a one-sentence test email. Subject: Connection test.'), google.identity(), google.checkReadAccess(),
            ]);
            const report = { at: new Date().toISOString() };
            ['gemini', 'gmail', 'threads'].forEach((key, i) => { const r = settled[i]; report[key] = r.status === 'fulfilled'
              ? { ok: true, detail: key === 'gmail' ? r.value.email : key === 'threads' ? r.value : 'Gemini generated an email successfully.' }
              : { ok: false, detail: safeError(r.reason) }; });
            await store.write('diagnostics', report); return report;
          });
          return json(res, results);
        }
        throw new AppError('Unknown action.', 404);
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(await readFile(path.join(root, 'public', file)));
      }
      throw new AppError('Not found.', 404);
    } catch (error) { json(res, { error: safeError(error) }, error.status || 500); }
  });
  return { server, tick };
}
function safeError(error) {
  if (error instanceof AppError) return error.message;
  if (error.code === 'ENOTFOUND' || error.cause?.code === 'ENOTFOUND') return 'Cannot reach Google. Check your internet connection.';
  if (error.message?.includes('invalid_grant')) return 'Google rejected these credentials. Reconnect Gmail, or check that the service account key is still valid.';
  return 'The connection failed. Check your Google API configuration and credentials, then try again.';
}
