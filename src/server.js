import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { all, one, run, migrate, log } from './db.js';
import * as auth from './auth.js';
import { forToken } from './ig.js';
import * as engine from './engine.js';
import { privacyPage, deletionPage, termsPage } from './legal.js';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update(`${PASSWORD}:${process.env.INSTAGRAM_APP_SECRET || ''}:instadm`).digest('hex');
const SESSION = crypto.createHmac('sha256', SECRET).update('session').digest('hex');

const app = express();
app.set('trust proxy', true);

// --- Meta webhooks (public; registered before express.json so the raw body is kept for the signature) ---
// Meta signs with the app secret from App settings → Basic; the Instagram app secret is also accepted
const WEBHOOK_SECRETS = [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(Boolean);
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN
  || crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET || SECRET).update('webhook-verify').digest('hex').slice(0, 24);
let lastSignatureWarning = 0;

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    log('info', 'Webhook verificado pela Meta');
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const signature = Buffer.from(String(req.headers['x-hub-signature-256'] || ''));
  const valid = Buffer.isBuffer(req.body) && WEBHOOK_SECRETS.some((secret) => {
    const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`);
    return signature.length === expected.length && crypto.timingSafeEqual(signature, expected);
  });
  if (!valid) {
    if (Date.now() - lastSignatureWarning > 3600000) {
      lastSignatureWarning = Date.now();
      log('warn', 'Webhook com assinatura inválida — confira META_APP_SECRET (App settings → Basic → App secret)');
    }
    return res.sendStatus(401);
  }
  // Answer right away; the event only goes into the queue, which the worker sends
  res.sendStatus(200);
  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return;
  }
  engine.handleWebhook(body).catch((err) => log('error', `Falha ao processar webhook: ${err.message}`));
});

app.use(express.json());

// --- Single-password auth (APP_PASSWORD) ---
function isLogged(req) {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('instadm='));
  const value = cookie?.slice('instadm='.length) || '';
  return value.length === SESSION.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(SESSION));
}

app.post('/api/login', (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const expected = Buffer.from(PASSWORD);
  if (!PASSWORD || (given.length === expected.length && crypto.timingSafeEqual(given, expected))) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `instadm=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}${secure}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

// Public pages required by Meta
app.get(['/privacy', '/privacidade'], (req, res) => res.type('html').send(privacyPage()));
app.get(['/data-deletion', '/exclusao-de-dados'], (req, res) => res.type('html').send(deletionPage()));
app.get(['/terms', '/termos'], (req, res) => res.type('html').send(termsPage()));

app.use('/api', (req, res, next) => (isLogged(req) ? next() : res.status(401).json({ error: 'login' })));

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message }));

// --- Instagram accounts (own Meta app) ---
// APP_URL must be the public address; an internal one (e.g. http://service_name:80) is ignored
const APP_URL = (() => {
  const raw = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol === 'https:' && hostname.includes('.') && !hostname.includes('_')) return raw;
  } catch { /* invalid URL */ }
  console.warn(`APP_URL "${raw}" is not a public https address — using the request host instead`);
  return null;
})();
const baseUrl = (req) => APP_URL || `${req.protocol}://${req.headers.host}`;
const redirectUri = (req) => `${baseUrl(req)}/auth/callback`;
const oauthState = (hoursAgo = 0) =>
  crypto.createHmac('sha256', SECRET).update(`oauth:${Math.floor(Date.now() / 3600000) - hoursAgo}`).digest('hex').slice(0, 32);

const publicAccount = (a, sent) => ({
  id: a.id,
  username: a.username,
  profile_picture_url: a.profile_picture_url,
  connected: !!a.token,
  token_expires_at: a.token_expires_at,
  last_error: a.last_error,
  sent_last_hour: sent[a.id] || 0,
  webhook_status: a.webhook_status,
  last_webhook_at: a.last_webhook_at,
});

app.get('/api/state', wrap(async (req, res) => {
  const stats = await engine.queueStats();
  const accounts = await all('SELECT * FROM accounts ORDER BY id');
  res.json({
    accounts: accounts.map((a) => publicAccount(a, stats.sentLastHour)),
    redirectUri: redirectUri(req),
    webhook: { url: `${baseUrl(req)}/webhook`, verifyToken: VERIFY_TOKEN, metaSecretConfigured: !!process.env.META_APP_SECRET },
    engine: engine.status,
    queue: { pending: stats.pending, failed24h: stats.failed24h, maxPerHour: stats.maxPerHour },
  });
}));

app.post('/api/connect', wrap(async (req, res) => {
  res.json({ url: auth.authorizeUrl(redirectUri(req), oauthState()) });
}));

app.post('/api/accounts/:id/disconnect', wrap(async (req, res) => {
  await auth.disconnect(req.params.id);
  res.json({ ok: true });
}));

async function connectedAccount(id) {
  const acc = await one('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!acc?.token) throw fail('Conta não conectada');
  return acc;
}

app.get('/api/accounts/:id/media', wrap(async (req, res) => {
  const acc = await connectedAccount(req.params.id);
  res.json((await forToken(acc.token).listMedia(24)).data || []);
}));

// --- Automations ---
const FIELDS = ['account_id', 'name', 'on_comments', 'on_stories', 'on_dms', 'keywords', 'match_mode', 'media_id', 'public_replies',
  'msg1_text', 'button_title', 'msg2_text', 'link_url', 'link_button_title'];
const LABELS = {
  name: 'Nome', keywords: 'Palavras-chave', msg1_text: 'Texto da 1ª mensagem', button_title: 'Texto do botão',
  msg2_text: 'Texto da mensagem com link', link_url: 'Link', link_button_title: 'Texto do botão do link',
};

async function validate(body) {
  const a = {};
  for (const f of FIELDS) a[f] = body[f] ?? null;
  for (const f of ['on_comments', 'on_stories', 'on_dms']) a[f] = !!a[f];
  a.match_mode = a.match_mode === 'exact' ? 'exact' : 'contains';
  a.media_id = a.media_id || null;
  if (!a.account_id || !(await one('SELECT 1 AS x FROM accounts WHERE id = $1', [a.account_id]))) throw fail('Escolha a conta do Instagram');
  for (const f of Object.keys(LABELS)) {
    a[f] = String(a[f] || '').trim();
    if (!a[f]) throw fail(`Campo obrigatório: ${LABELS[f]}`);
  }
  if (!a.on_comments && !a.on_stories && !a.on_dms) throw fail('Escolha ao menos um gatilho');
  a.public_replies = [...new Set(String(a.public_replies || '').split('\n').map((l) => l.trim()).filter(Boolean))].join('\n') || null;
  const replies = a.public_replies ? a.public_replies.split('\n').length : 0;
  if (a.on_comments && replies < 5) throw fail(`Cadastre pelo menos 5 respostas diferentes para o comentário (tem ${replies})`);
  if (a.button_title.length > 20) throw fail('O texto do botão deve ter até 20 caracteres');
  if (!/^https?:\/\//i.test(a.link_url)) throw fail('O link deve começar com http:// ou https://');
  return a;
}

async function withStats(a) {
  if (!a) return null;
  const s = await one('SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE clicked) AS clicked FROM runs WHERE automation_id = $1', [a.id]);
  const q = await one("SELECT COUNT(*) AS n FROM queue WHERE automation_id = $1 AND status = 'pending'", [a.id]);
  return { ...a, stats: { ...s, queued: q.n } };
}

const getAutomation = async (id) =>
  withStats(await one('SELECT au.*, ac.username AS account_username FROM automations au LEFT JOIN accounts ac ON ac.id = au.account_id WHERE au.id = $1', [id]));

app.get('/api/automations', wrap(async (req, res) => {
  const rows = await all('SELECT au.*, ac.username AS account_username FROM automations au LEFT JOIN accounts ac ON ac.id = au.account_id ORDER BY au.id DESC');
  res.json(await Promise.all(rows.map(withStats)));
}));

app.post('/api/automations', wrap(async (req, res) => {
  const a = await validate(req.body);
  const now = Date.now();
  const cols = [...FIELDS, 'created_at', 'updated_at'];
  const r = await one(
    `INSERT INTO automations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...FIELDS.map((f) => a[f]), now, now]
  );
  res.json(await getAutomation(r.id));
}));

app.put('/api/automations/:id', wrap(async (req, res) => {
  const a = await validate(req.body);
  await run(
    `UPDATE automations SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')}, updated_at = $${FIELDS.length + 1} WHERE id = $${FIELDS.length + 2}`,
    [...FIELDS.map((f) => a[f]), Date.now(), req.params.id]
  );
  res.json(await getAutomation(req.params.id));
}));

app.post('/api/automations/:id/toggle', wrap(async (req, res) => {
  const cur = await one('SELECT * FROM automations WHERE id = $1', [req.params.id]);
  if (!cur) throw fail('Automação não encontrada');
  const active = !!req.body?.active;
  // activated_at prevents replying to comments/messages from before activation
  await run('UPDATE automations SET active = $1, activated_at = $2 WHERE id = $3', [active, active ? Date.now() : cur.activated_at, cur.id]);
  log('info', `Automação "${cur.name}" ${active ? 'ativada' : 'desativada'}`, cur.id);
  res.json(await getAutomation(cur.id));
}));

app.delete('/api/automations/:id', wrap(async (req, res) => {
  await run('DELETE FROM automations WHERE id = $1', [req.params.id]);
  await run('DELETE FROM waiting WHERE automation_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// --- Queue ---
app.get('/api/queue', wrap(async (req, res) => {
  res.json(await all(
    `SELECT q.*, a.name AS automation_name, ac.username AS account_username FROM queue q
     LEFT JOIN automations a ON a.id = q.automation_id LEFT JOIN accounts ac ON ac.id = q.account_id
     WHERE q.status IN ('pending', 'failed') ORDER BY q.status DESC, q.event_at ASC LIMIT 200`
  ));
}));

app.post('/api/queue/:id/retry', wrap(async (req, res) => {
  // Extends the deadline only up to Meta's real limit (7 days for comments / 24h for messages)
  await run(
    `UPDATE queue SET status = 'pending', next_at = $1, attempts = 0, locked_until = 0, done_at = NULL,
       deadline = GREATEST(deadline, CASE WHEN source = 'comment' THEN event_at + $2 ELSE event_at + $3 END)
     WHERE id = $4 AND status = 'failed'`,
    [Date.now(), 7 * 24 * 3600 * 1000 - 30 * 60 * 1000, 24 * 3600 * 1000 - 10 * 60 * 1000, req.params.id]
  );
  res.json({ ok: true });
}));

app.get('/api/logs', wrap(async (req, res) => {
  res.json(await all('SELECT * FROM logs ORDER BY id DESC LIMIT 100'));
}));

// Diagnostics: what the Instagram API returns right now, per account (never exposes tokens)
app.get('/api/debug', wrap(async (req, res) => {
  const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  const attempt = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      return { error: err.message };
    }
  };
  const accounts = await all('SELECT * FROM accounts ORDER BY id');
  res.json({
    now: new Date().toISOString(),
    engine: { lastRun: iso(engine.status.lastRun) },
    accounts: await Promise.all(accounts.map(async (acc) => {
      const api = forToken(acc.token);
      return {
        id: acc.id, username: acc.username, connected: !!acc.token, token_expires_at: iso(acc.token_expires_at), last_error: acc.last_error,
        me: acc.token ? await attempt(() => api.getMe()) : null,
        media: acc.token ? await attempt(async () => Promise.all(((await api.listMedia(5)).data || []).map(async (m) => ({
          id: m.id, caption: (m.caption || '').slice(0, 50), timestamp: m.timestamp, comments_count: m.comments_count,
          comments: await attempt(async () => ((await api.listComments(m.id)).data || []).slice(0, 10)
            .map((c) => ({ id: c.id, text: c.text, timestamp: c.timestamp, username: c.username, from: c.from }))),
        })))) : null,
        conversations: acc.token ? await attempt(async () => ((await api.listConversations()).data || []).slice(0, 5).map((c) => ({
          updated_time: c.updated_time,
          messages: (c.messages?.data || []).slice(0, 3).map((m) => ({ from: m.from?.username || m.from?.id, text: m.message, created_time: m.created_time })),
        }))) : null,
      };
    })),
    automations: (await all('SELECT id, account_id, name, active, activated_at, on_comments, on_stories, on_dms, media_id, keywords FROM automations ORDER BY id'))
      .map((a) => ({ ...a, activated_at: iso(a.activated_at) })),
    queue: await all('SELECT event_id, kind, status, attempts, last_error, username FROM queue ORDER BY id DESC LIMIT 10'),
    logs: (await all('SELECT at, level, message FROM logs ORDER BY id DESC LIMIT 20')).map((l) => `${iso(l.at)} [${l.level}] ${l.message}`),
  });
}));

// Return from Instagram login
app.get('/auth/callback', async (req, res) => {
  const back = (msg) => res.redirect(`/?error=${encodeURIComponent(msg)}`);
  if (!isLogged(req)) return back('Entre no painel antes de conectar uma conta');
  if (req.query.error) return back(String(req.query.error_description || req.query.error));
  // Accepts this hour's or the previous hour's state (slow logins)
  if (![0, 1].some((h) => req.query.state === oauthState(h))) return back('O login expirou, tente de novo');
  try {
    const acc = await auth.handleCallback(String(req.query.code || ''), redirectUri(req));
    res.redirect(`/?connected=${encodeURIComponent(acc.username)}`);
  } catch (err) {
    back(err.message);
  }
});

app.use(express.static(path.resolve('public')));

await migrate();
app.listen(PORT, () => {
  console.log(`instadm listening on http://localhost:${PORT}`);
  if (!PASSWORD) console.warn('WARNING: APP_PASSWORD is not set — the dashboard has no password');
  engine.start();
});
