import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { all, one, run, migrate, getSetting, setSetting, log } from './db.js';
import * as auth from './auth.js';
import * as ig from './ig.js';
import * as engine from './engine.js';

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update(`${PASSWORD}:${process.env.INSTAGRAM_APP_SECRET || ''}:instadm`).digest('hex');
const SESSION = crypto.createHmac('sha256', SECRET).update('session').digest('hex');

const app = express();
app.use(express.json());

// --- Autenticação por senha única (APP_PASSWORD) ---
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
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `instadm=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}${secure}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

app.use('/api', (req, res, next) => (isLogged(req) ? next() : res.status(401).json({ error: 'login' })));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message }));

// --- Conexão Instagram (app próprio na Meta) ---
const baseUrl = (req) => process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
const redirectUri = (req) => `${baseUrl(req)}/auth/callback`;
const oauthState = () => crypto.createHmac('sha256', SECRET).update(`oauth:${Math.floor(Date.now() / 3600000)}`).digest('hex').slice(0, 32);

app.get('/api/account', wrap(async (req, res) => {
  const token = await auth.tokenInfo();
  let profile = null;
  let error = null;
  if (token.connected) {
    try {
      profile = JSON.parse((await getSetting('profile')) || 'null') || (await ig.getMe());
      await setSetting('profile', JSON.stringify(profile));
    } catch (err) {
      error = err.message;
    }
  }
  res.json({
    connected: token.connected,
    tokenExpiresAt: token.expiresAt,
    profile,
    error,
    redirectUri: redirectUri(req),
    engine: engine.status,
    queue: await engine.queueStats(),
  });
}));

async function afterConnect() {
  await setSetting('profile', null);
  engine.resetAccountCache();
  const profile = await ig.getMe();
  await setSetting('profile', JSON.stringify(profile));
  log('info', `Conta @${profile.username} conectada`);
  return profile;
}

app.post('/api/connect', wrap(async (req, res) => {
  res.json({ url: auth.authorizeUrl(redirectUri(req), oauthState()) });
}));

// Alternativa ao login: colar o token gerado no painel da Meta
app.post('/api/connect/token', wrap(async (req, res) => {
  await auth.saveManualToken(req.body?.token);
  try {
    res.json({ ok: true, profile: await afterConnect() });
  } catch (err) {
    await auth.clearToken();
    throw Object.assign(new Error(`Token inválido: ${err.message}`), { status: 400 });
  }
}));

app.post('/api/disconnect', wrap(async (req, res) => {
  await auth.clearToken();
  await setSetting('profile', null);
  engine.resetAccountCache();
  log('info', 'Conta desconectada');
  res.json({ ok: true });
}));

app.get('/api/media', wrap(async (req, res) => {
  const media = await ig.listMedia(24);
  res.json(media.data || []);
}));

// --- Automações ---
const FIELDS = ['name', 'on_comments', 'on_stories', 'on_dms', 'keywords', 'match_mode', 'media_id', 'public_replies',
  'msg1_text', 'button_title', 'msg2_text', 'link_url', 'link_button_title'];

function validate(body) {
  const a = {};
  for (const f of FIELDS) a[f] = body[f] ?? null;
  for (const f of ['on_comments', 'on_stories', 'on_dms']) a[f] = !!a[f];
  a.match_mode = a.match_mode === 'exact' ? 'exact' : 'contains';
  a.media_id = a.media_id || null;
  for (const f of ['name', 'keywords', 'msg1_text', 'button_title', 'msg2_text', 'link_url', 'link_button_title']) {
    a[f] = String(a[f] || '').trim();
    if (!a[f]) throw Object.assign(new Error(`Campo obrigatório: ${f}`), { status: 400 });
  }
  if (!a.on_comments && !a.on_stories && !a.on_dms) throw Object.assign(new Error('Escolha ao menos um gatilho'), { status: 400 });
  a.public_replies = [...new Set(String(a.public_replies || '').split('\n').map((l) => l.trim()).filter(Boolean))].join('\n') || null;
  const replies = a.public_replies ? a.public_replies.split('\n').length : 0;
  if (a.on_comments && replies < 5) throw Object.assign(new Error(`Cadastre pelo menos 5 respostas diferentes para o comentário (tem ${replies})`), { status: 400 });
  if (a.button_title.length > 20) throw Object.assign(new Error('O texto do botão deve ter até 20 caracteres'), { status: 400 });
  if (!/^https?:\/\//i.test(a.link_url)) throw Object.assign(new Error('O link deve começar com http:// ou https://'), { status: 400 });
  return a;
}

async function withStats(a) {
  if (!a) return null;
  const s = await one('SELECT COUNT(*) AS sent, COUNT(*) FILTER (WHERE clicked) AS clicked FROM runs WHERE automation_id = $1', [a.id]);
  const q = await one("SELECT COUNT(*) AS n FROM queue WHERE automation_id = $1 AND status = 'pending'", [a.id]);
  return { ...a, stats: { ...s, queued: q.n } };
}

const getAutomation = async (id) => withStats(await one('SELECT * FROM automations WHERE id = $1', [id]));

app.get('/api/automations', wrap(async (req, res) => {
  const rows = await all('SELECT * FROM automations ORDER BY id DESC');
  res.json(await Promise.all(rows.map(withStats)));
}));

app.post('/api/automations', wrap(async (req, res) => {
  const a = validate(req.body);
  const now = Date.now();
  const cols = [...FIELDS, 'created_at', 'updated_at'];
  const r = await one(
    `INSERT INTO automations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...FIELDS.map((f) => a[f]), now, now]
  );
  res.json(await getAutomation(r.id));
}));

app.put('/api/automations/:id', wrap(async (req, res) => {
  const a = validate(req.body);
  await run(
    `UPDATE automations SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')}, updated_at = $${FIELDS.length + 1} WHERE id = $${FIELDS.length + 2}`,
    [...FIELDS.map((f) => a[f]), Date.now(), req.params.id]
  );
  res.json(await getAutomation(req.params.id));
}));

app.post('/api/automations/:id/toggle', wrap(async (req, res) => {
  const cur = await one('SELECT * FROM automations WHERE id = $1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'Não encontrada' });
  const active = !!req.body?.active;
  // activated_at evita responder comentários/mensagens anteriores à ativação
  await run('UPDATE automations SET active = $1, activated_at = $2 WHERE id = $3',
    [active, active ? Date.now() : cur.activated_at, cur.id]);
  log('info', `Automação "${cur.name}" ${active ? 'ativada' : 'desativada'}`, cur.id);
  res.json(await getAutomation(cur.id));
}));

app.delete('/api/automations/:id', wrap(async (req, res) => {
  await run('DELETE FROM automations WHERE id = $1', [req.params.id]);
  await run('DELETE FROM pending WHERE automation_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// --- Fila ---
app.get('/api/queue', wrap(async (req, res) => {
  res.json(await all(
    `SELECT q.*, a.name AS automation_name FROM queue q LEFT JOIN automations a ON a.id = q.automation_id
     WHERE q.status IN ('pending', 'failed') ORDER BY q.status DESC, q.event_at ASC LIMIT 200`
  ));
}));

app.post('/api/queue/:id/retry', wrap(async (req, res) => {
  const now = Date.now();
  // Renova o prazo só até o limite real da Meta (7 dias do comentário / 24h da mensagem)
  await run(
    `UPDATE queue SET status = 'pending', next_at = $1, attempts = 0, locked_until = 0, done_at = NULL,
       deadline = GREATEST(deadline, CASE WHEN source = 'comment' THEN event_at + $2 ELSE event_at + $3 END)
     WHERE id = $4 AND status = 'failed'`,
    [now, 7 * 24 * 3600 * 1000 - 30 * 60 * 1000, 24 * 3600 * 1000 - 10 * 60 * 1000, req.params.id]
  );
  res.json({ ok: true });
}));

// Diagnóstico: o que a API do Instagram devolve agora (sem expor o token)
app.get('/api/debug', wrap(async (req, res) => {
  const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
  const attempt = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      return { error: err.message };
    }
  };
  const token = await auth.tokenInfo();
  const automations = (await all('SELECT * FROM automations ORDER BY id')).map((a) => ({
    id: a.id, name: a.name, active: a.active, activated_at: iso(a.activated_at),
    on_comments: a.on_comments, on_stories: a.on_stories, on_dms: a.on_dms, media_id: a.media_id, keywords: a.keywords,
  }));
  const media = await attempt(async () => {
    const list = (await ig.listMedia(5)).data || [];
    return Promise.all(list.map(async (m) => ({
      id: m.id,
      caption: (m.caption || '').slice(0, 50),
      timestamp: m.timestamp,
      comments_count: m.comments_count,
      cache: await one('SELECT comments_count, checked_at FROM media_cache WHERE media_id = $1', [m.id]),
      comments: await attempt(async () => ((await ig.listComments(m.id)).data || []).slice(0, 10)
        .map((c) => ({ id: c.id, text: c.text, timestamp: c.timestamp, username: c.username, from: c.from }))),
    })));
  });
  const conversations = await attempt(async () => ((await ig.listConversations()).data || []).slice(0, 5).map((c) => ({
    updated_time: c.updated_time,
    messages: (c.messages?.data || []).slice(0, 3).map((m) => ({ from: m.from?.username || m.from?.id, text: m.message, created_time: m.created_time })),
  })));
  res.json({
    now: new Date().toISOString(),
    token: { connected: token.connected, expiresAt: iso(token.expiresAt) },
    me: await attempt(() => ig.getMe()),
    engine: { ...engine.status, lastRun: iso(engine.status.lastRun) },
    automations,
    media,
    conversations,
    queue: await all('SELECT event_id, kind, status, attempts, last_error, username FROM queue ORDER BY id DESC LIMIT 10'),
    logs: (await all('SELECT at, level, message FROM logs ORDER BY id DESC LIMIT 20')).map((l) => `${iso(l.at)} [${l.level}] ${l.message}`),
  });
}));

app.get('/api/logs', wrap(async (req, res) => {
  res.json(await all('SELECT * FROM logs ORDER BY id DESC LIMIT 100'));
}));

// Retorno do login do Instagram
app.get('/auth/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/?error=${encodeURIComponent(msg)}`);
  if (!isLogged(req)) return fail('Entre no painel antes de conectar');
  if (req.query.error) return fail(String(req.query.error_description || req.query.error));
  // Aceita o state desta hora ou da anterior (login demorado)
  const valid = [0, 1].some((h) => req.query.state === crypto.createHmac('sha256', SECRET).update(`oauth:${Math.floor(Date.now() / 3600000) - h}`).digest('hex').slice(0, 32));
  if (!valid) return fail('Login expirado, tente de novo');
  try {
    await auth.handleCallback(String(req.query.code || ''), redirectUri(req));
    await afterConnect();
    res.redirect('/');
  } catch (err) {
    fail(err.message);
  }
});

app.use(express.static(path.resolve('public')));

await migrate();
app.listen(PORT, () => {
  console.log(`instadm rodando em http://localhost:${PORT}`);
  if (!PASSWORD) console.warn('ATENÇÃO: APP_PASSWORD não definida — painel sem senha');
  engine.start();
});
