import { all, one, run, tx, getSetting, setSetting, log, cleanup } from './db.js';
import * as ig from './ig.js';
import { getToken, refreshIfNeeded } from './auth.js';

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);
const MEDIA_LIMIT = Number(process.env.MEDIA_LIMIT || 12);
// Limite só para a 1ª mensagem; a mensagem do link (pedida pelo usuário) não entra na conta
const MAX_SENDS_PER_HOUR = Number(process.env.MAX_SENDS_PER_HOUR || 120);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 24);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Margem de sobreposição entre varreduras: reavaliar um pouco do passado é seguro (event_id é único)
const OVERLAP = 10 * MIN;
const RETRY_STEPS = [30 * 1000, 2 * MIN, 10 * MIN, 30 * MIN, HOUR];

export const status = { lastRun: null, lastError: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pausa aleatória antes de cada envio para não parecer robô
const humanDelay = () => (process.env.SEND_DELAY === '0' ? null : sleep(1500 + Math.random() * 3500));

const normalize = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function matches(automation, text) {
  const t = normalize(text);
  if (!t) return false;
  const keywords = automation.keywords.split(',').map(normalize).filter(Boolean);
  return keywords.some((k) =>
    automation.match_mode === 'exact' ? t === k : new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)
  );
}

// ---------------------------------------------------------------------------
// Detecção (polling): só coloca na fila, nunca envia direto
// ---------------------------------------------------------------------------

async function enqueue(item) {
  const now = Date.now();
  const inserted = await one(
    `INSERT INTO queue (event_id, kind, automation_id, source, user_id, username, comment_id, event_at, deadline, next_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [item.eventId, item.kind, item.automationId, item.source, item.userId || null, item.username || null,
      item.commentId || null, item.eventAt, item.deadline, now, now]
  );
  if (inserted) {
    const who = item.username ? `@${item.username}` : item.userId;
    log('info', item.kind === 'link' ? `${who} tocou no botão — link na fila` : `${who} (${item.source}) entrou na fila`, item.automationId);
  }
  return !!inserted;
}

async function pollComments(automations, me) {
  const commentAutos = automations.filter((a) => a.on_comments);
  if (!commentAutos.length) return;

  const myIds = new Set([me.id, me.user_id].filter(Boolean).map(String));
  const now = Date.now();
  const media = (await ig.listMedia(MEDIA_LIMIT)).data || [];
  // Posts escolhidos numa automação podem ser mais antigos que os recentes listados
  for (const id of new Set(commentAutos.map((a) => a.media_id).filter(Boolean))) {
    if (!media.some((m) => m.id === id)) media.push(await ig.getMedia(id).catch(() => ({ id, comments_count: -1 })));
  }

  for (const md of media) {
    const relevant = commentAutos.filter((a) => !a.media_id || a.media_id === md.id);
    if (!relevant.length) continue;

    const cache = await one('SELECT * FROM media_cache WHERE media_id = $1', [md.id]);
    // Só varre quando a contagem mudou, ou a cada 5 min por segurança
    const force = !cache || now - cache.checked_at > 5 * MIN;
    if (!force && cache.comments_count === md.comments_count) continue;

    const scanStart = Date.now();
    const stopBefore = Math.max(
      Math.min(...relevant.map((a) => a.activated_at)),
      (cache?.checked_at || 0) - OVERLAP,
      now - 7 * DAY + 30 * MIN // depois de 7 dias a Meta não deixa mais responder no privado
    );

    // Comentários vêm do mais novo para o mais antigo: pagina até passar do ponto já varrido
    const found = [];
    let after;
    for (let page = 0; page < 40; page++) {
      const res = await ig.listComments(md.id, after);
      let reachedOld = false;
      for (const c of res.data || []) {
        if (Date.parse(c.timestamp) < stopBefore) reachedOld = true;
        found.push(c, ...(c.replies?.data || []));
      }
      after = res.paging?.cursors?.after;
      if (reachedOld || !after || !res.paging?.next) break;
    }

    found.sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
    for (const c of found) {
      const at = Date.parse(c.timestamp);
      if (at < stopBefore || myIds.has(String(c.from?.id)) || c.username === me.username) continue;
      const a = relevant.find((x) => at >= x.activated_at && matches(x, c.text));
      if (!a) continue;
      await enqueue({
        eventId: `comment:${c.id}`, kind: 'first', automationId: a.id, source: 'comment',
        userId: c.from?.id ? String(c.from.id) : null, username: c.username, commentId: c.id,
        eventAt: at, deadline: at + 7 * DAY - 30 * MIN,
      });
    }

    await run(
      `INSERT INTO media_cache (media_id, comments_count, checked_at) VALUES ($1, $2, $3)
       ON CONFLICT (media_id) DO UPDATE SET comments_count = excluded.comments_count, checked_at = excluded.checked_at`,
      [md.id, md.comments_count ?? 0, scanStart]
    );
  }
}

async function pollConversations(automations, me) {
  const dmAutos = automations.filter((a) => a.on_dms || a.on_stories);
  const hasPending = await one('SELECT 1 AS x FROM pending LIMIT 1');
  if (!dmAutos.length && !hasPending) return;

  const myIds = new Set([me.id, me.user_id].filter(Boolean).map(String));
  const now = Date.now();
  const scanStart = now;
  const watermark = Number(await getSetting('conv_watermark')) || now - DAY;
  const stopBefore = Math.max(watermark - OVERLAP, now - DAY);

  // Conversas vêm da atualizada mais recentemente para a mais antiga
  const messages = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const res = await ig.listConversations(after);
    let reachedOld = false;
    for (const conv of res.data || []) {
      if (Date.parse(conv.updated_time) < stopBefore) { reachedOld = true; break; }
      messages.push(...(conv.messages?.data || []));
    }
    after = res.paging?.cursors?.after;
    if (reachedOld || !after || !res.paging?.next) break;
  }

  const fresh = messages
    .filter((m) => m.from?.id && !myIds.has(String(m.from.id)) && Date.parse(m.created_time) >= stopBefore)
    .sort((x, y) => Date.parse(x.created_time) - Date.parse(y.created_time));

  for (const m of fresh) {
    const userId = String(m.from.id);
    const username = m.from.username;
    const text = m.message || '';
    const at = Date.parse(m.created_time);

    // Toque no botão (quick reply chega como mensagem com o título do botão)
    const p = await one('SELECT * FROM pending WHERE igsid = $1', [userId]);
    if (p) {
      const a = await one('SELECT * FROM automations WHERE id = $1', [p.automation_id]);
      if (a && normalize(text) === normalize(a.button_title)) {
        await tx(async (c) => {
          await c.query(
            `INSERT INTO queue (event_id, kind, automation_id, source, user_id, username, event_at, deadline, next_at, created_at)
             VALUES ($1, 'link', $2, 'click', $3, $4, $5, $6, $7, $7) ON CONFLICT (event_id) DO NOTHING`,
            [`link:${m.id}`, a.id, userId, username || null, at, at + DAY - 10 * MIN, Date.now()]
          );
          await c.query('DELETE FROM pending WHERE igsid = $1', [userId]);
        });
        log('info', `${username ? `@${username}` : userId} tocou no botão — link na fila`, a.id);
        continue;
      }
    }
    if (await one('SELECT 1 AS x FROM queue WHERE event_id = $1', [`link:${m.id}`])) continue;

    const isStoryReply = !!m.story?.reply_to;
    const a = dmAutos.find((x) => (isStoryReply ? x.on_stories : x.on_dms) && at >= x.activated_at && matches(x, text));
    if (!a) continue;
    await enqueue({
      eventId: `msg:${m.id}`, kind: 'first', automationId: a.id, source: isStoryReply ? 'story' : 'dm',
      userId, username, eventAt: at, deadline: at + DAY - 10 * MIN,
    });
  }

  await setSetting('conv_watermark', scanStart);
}

let meCache = null;
export function resetAccountCache() {
  meCache = null;
}

async function pollCycle() {
  if (!(await getToken())) return;
  const automations = await all('SELECT * FROM automations WHERE active = true');
  const hasPending = await one('SELECT 1 AS x FROM pending LIMIT 1');
  if (!automations.length && !hasPending) return;

  meCache ??= await ig.getMe();
  await pollConversations(automations, meCache);
  await pollComments(automations, meCache);
}

let errorStreak = 0;
let lastMaintenance = 0;
async function pollLoop() {
  try {
    await pollCycle();
    status.lastError = null;
    errorStreak = 0;
  } catch (err) {
    status.lastError = err.message;
    if (errorStreak++ % 10 === 0) log('error', `Falha ao verificar o Instagram: ${err.message}`);
  }
  status.lastRun = Date.now();
  if (Date.now() - lastMaintenance > HOUR) {
    lastMaintenance = Date.now();
    await refreshIfNeeded();
    cleanup().catch(() => {});
  }
  setTimeout(pollLoop, POLL_SECONDS * 1000);
}

// ---------------------------------------------------------------------------
// Worker: envia o que está na fila, com retentativa até o prazo da Meta
// ---------------------------------------------------------------------------

function firstMessage(a) {
  return {
    message: {
      text: a.msg1_text,
      quick_replies: [{ content_type: 'text', title: a.button_title.slice(0, 20), payload: `AUTO_${a.id}` }],
    },
    fallback: { text: `${a.msg1_text}\n\nResponda "${a.button_title}" para receber.` },
  };
}

function linkMessage(a) {
  return {
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: a.msg2_text.slice(0, 640),
          buttons: [{ type: 'web_url', url: a.link_url, title: a.link_button_title }],
        },
      },
    },
    fallback: { text: `${a.msg2_text}\n\n${a.link_url}` },
  };
}

const errInfo = (err) => err?.data?.error || {};

// Sorteia uma resposta pública evitando repetir as últimas usadas nesta automação
const recentReplies = new Map();
export function pickReply(a) {
  const options = [...new Set((a.public_replies || '').split('\n').map((s) => s.trim()).filter(Boolean))];
  const recent = recentReplies.get(a.id) || [];
  const avoid = recent.slice(-Math.min(recent.length, Math.floor(options.length / 2)));
  const pool = options.filter((o) => !avoid.includes(o));
  const choice = (pool.length ? pool : options)[Math.floor(Math.random() * (pool.length || options.length))];
  recentReplies.set(a.id, [...recent, choice].slice(-10));
  return choice;
}

async function send(recipient, { message, fallback }) {
  await humanDelay();
  try {
    return await ig.sendMessage(recipient, message);
  } catch (err) {
    // Parâmetro inválido = Instagram recusou botão/quick reply; manda versão só texto
    if (errInfo(err).code !== 100 || errInfo(err).error_subcode) throw err;
    log('warn', `Formato com botão recusado (${err.message}); enviando só texto`);
    return await ig.sendMessage(recipient, fallback);
  }
}

// Erros que não adianta repetir
function isPermanent(err) {
  const { code, error_subcode: sub, message = '' } = errInfo(err);
  return code === 551 || sub === 33 || sub === 2534022 || sub === 2018278 || /already (been )?(replied|sent)/i.test(message);
}

function isRateLimit(err) {
  const { code } = errInfo(err);
  return [4, 17, 32, 613].includes(code);
}

async function firstSendsLastHour() {
  const r = await one("SELECT COUNT(*) AS n FROM queue WHERE kind = 'first' AND status = 'done' AND done_at > $1", [Date.now() - HOUR]);
  return r.n;
}

async function claimNext() {
  const now = Date.now();
  const budget = (await firstSendsLastHour()) < MAX_SENDS_PER_HOUR;
  // Trava a linha por 3 min: outra instância (se houver) pula ela
  return one(
    `UPDATE queue SET locked_until = $1 WHERE id = (
       SELECT id FROM queue
       WHERE status = 'pending' AND next_at <= $2 AND locked_until < $2 ${budget ? '' : "AND kind = 'link'"}
       ORDER BY (kind = 'link') DESC, event_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [now + 3 * MIN, now]
  );
}

async function finish(item, statusValue, error = null) {
  await run('UPDATE queue SET status = $1, last_error = $2, done_at = $3, locked_until = 0 WHERE id = $4',
    [statusValue, error, Date.now(), item.id]);
}

async function processItem(item) {
  const who = item.username ? `@${item.username}` : item.user_id;
  if (Date.now() > item.deadline) {
    await finish(item, 'failed', 'Prazo da Meta para responder venceu');
    return log('error', `Prazo vencido — ${who} não recebeu a mensagem`, item.automation_id);
  }
  const a = await one('SELECT * FROM automations WHERE id = $1', [item.automation_id]);
  if (!a) return finish(item, 'skipped', 'Automação excluída');

  try {
    if (item.kind === 'link') {
      await send({ id: item.user_id }, linkMessage(a));
      await tx(async (c) => {
        await c.query("UPDATE queue SET status = 'done', done_at = $1, locked_until = 0, last_error = NULL WHERE id = $2", [Date.now(), item.id]);
        await c.query('UPDATE runs SET clicked = true WHERE id = (SELECT MAX(id) FROM runs WHERE automation_id = $1 AND user_id = $2)', [a.id, item.user_id]);
      });
      return log('info', `Link enviado para ${who}`, a.id);
    }

    // Passo 2: resposta no comentário ("te mandei no direct")
    let retryError = null;
    if (item.comment_id && !item.public_done) {
      try {
        await humanDelay();
        await ig.replyToComment(item.comment_id, pickReply(a));
        log('info', `Resposta no comentário de ${who} publicada`, a.id);
      } catch (err) {
        if (!isPermanent(err)) retryError = err;
        else log('error', `Não foi possível responder o comentário de ${who}: ${err.message}`, a.id);
      }
      if (!retryError) {
        item.public_done = true;
        await run('UPDATE queue SET public_done = true WHERE id = $1', [item.id]);
      }
    }

    // Passo 3: 1ª mensagem na DM (não espera a resposta pública dar certo)
    let dmNote = null;
    if (!item.dm_done) {
      let dmFinished = true; // enviada, não repetida ou falha definitiva
      const recent = await one(
        `SELECT 1 AS x FROM runs WHERE automation_id = $1 AND at > $2
           AND (user_id = $3 OR alt_id = $3 OR (username IS NOT NULL AND username = $4))`,
        [a.id, Date.now() - COOLDOWN_HOURS * HOUR, item.user_id || '-', item.username || null]);
      if (recent) {
        dmNote = `DM não repetida: já recebeu nas últimas ${COOLDOWN_HOURS}h`;
        log('info', `${who} já recebeu esta DM nas últimas ${COOLDOWN_HOURS}h — não repetida`, a.id);
      } else {
        try {
          const recipient = item.comment_id ? { comment_id: item.comment_id } : { id: item.user_id };
          const res = await send(recipient, firstMessage(a));
          const igsid = res?.recipient_id || item.user_id;
          const now = Date.now();
          await tx(async (c) => {
            await c.query('UPDATE queue SET user_id = COALESCE(user_id, $1) WHERE id = $2', [igsid, item.id]);
            await c.query('INSERT INTO runs (automation_id, user_id, alt_id, username, source, at) VALUES ($1, $2, $3, $4, $5, $6)',
              [a.id, igsid, item.user_id || null, item.username || null, item.source, now]);
            await c.query(`INSERT INTO pending (igsid, automation_id, at) VALUES ($1, $2, $3)
              ON CONFLICT (igsid) DO UPDATE SET automation_id = excluded.automation_id, at = excluded.at`, [igsid, a.id, now]);
          });
          log('info', `1ª mensagem enviada para ${who} (${item.source})`, a.id);
        } catch (err) {
          if (isPermanent(err)) {
            dmNote = `DM falhou: ${err.message}`;
            log('error', `Não foi possível enviar a DM para ${who}: ${err.message}`, a.id);
          } else {
            dmFinished = false;
            retryError ??= err;
          }
        }
      }
      if (dmFinished) {
        item.dm_done = true;
        await run('UPDATE queue SET dm_done = true WHERE id = $1', [item.id]);
      }
    }

    if (item.dm_done && (item.public_done || !item.comment_id)) {
      const failed = dmNote?.startsWith('DM falhou');
      const skipped = !item.comment_id && dmNote && !failed;
      return finish(item, failed ? 'failed' : skipped ? 'skipped' : 'done', dmNote);
    }
    if (retryError) throw retryError;
  } catch (err) {
    if (isPermanent(err)) {
      await finish(item, 'failed', err.message);
      return log('error', `Não foi possível enviar para ${who}: ${err.message}`, a.id);
    }
    const attempts = item.attempts + (isRateLimit(err) ? 0 : 1);
    const wait = isRateLimit(err) ? 10 * MIN : RETRY_STEPS[Math.min(attempts - 1, RETRY_STEPS.length - 1)];
    const nextAt = Math.min(Date.now() + wait, item.deadline - MIN);
    await run('UPDATE queue SET attempts = $1, next_at = $2, last_error = $3, locked_until = 0 WHERE id = $4',
      [attempts, nextAt, err.message, item.id]);
    if (attempts <= 1) log('warn', `Falha ao enviar para ${who}, vai tentar de novo: ${err.message}`, a.id);
  }
}

async function workerLoop() {
  for (;;) {
    let item = null;
    try {
      if (await getToken()) item = await claimNext();
      if (item) await processItem(item);
    } catch (err) {
      console.error('[worker]', err);
      if (item) await run('UPDATE queue SET locked_until = 0, next_at = $1 WHERE id = $2', [Date.now() + MIN, item.id]).catch(() => {});
    }
    if (!item) await sleep(3000);
  }
}

export async function queueStats() {
  const rows = await all("SELECT status, COUNT(*) AS n FROM queue WHERE status = 'pending' OR created_at > $1 GROUP BY status", [Date.now() - DAY]);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    pending: by.pending || 0,
    sentLastHour: await firstSendsLastHour(),
    maxPerHour: MAX_SENDS_PER_HOUR,
    failed24h: by.failed || 0,
  };
}

export function start() {
  log('info', `Motor iniciado (verificação a cada ${POLL_SECONDS}s, até ${MAX_SENDS_PER_HOUR} 1ªs mensagens/hora)`);
  pollLoop();
  workerLoop();
}
