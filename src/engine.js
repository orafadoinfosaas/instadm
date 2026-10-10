import { all, one, run, tx, log, cleanup } from './db.js';
import { forToken } from './ig.js';
import { refreshTokens } from './auth.js';

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);
const MEDIA_LIMIT = Number(process.env.MEDIA_LIMIT || 12);
// Per-account cap on first DMs only; the link message (requested by the user) never waits for it
const MAX_SENDS_PER_HOUR = Number(process.env.MAX_SENDS_PER_HOUR || 120);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 24);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Overlap between scans: re-reading a bit of the past is safe (event_id is unique)
const OVERLAP = 10 * MIN;
const RETRY_STEPS = [30 * 1000, 2 * MIN, 10 * MIN, 30 * MIN, HOUR];

export const status = { lastRun: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Random pause before each send so it does not look robotic
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

const who = (username, id) => (username ? `@${username}` : id || 'someone');

// ---------------------------------------------------------------------------
// Detection (polling): only enqueues, never sends directly
// ---------------------------------------------------------------------------

async function enqueue(acc, item) {
  const now = Date.now();
  const inserted = await one(
    `INSERT INTO queue (event_id, account_id, kind, automation_id, source, user_id, username, comment_id, event_at, deadline, next_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [`${acc.id}:${item.eventId}`, acc.id, item.kind, item.automationId, item.source, item.userId || null,
      item.username || null, item.commentId || null, item.eventAt, item.deadline, now]
  );
  if (inserted) log('info', `[@${acc.username}] ${who(item.username, item.userId)} (${item.source}) queued`, item.automationId);
  return !!inserted;
}

const myIdsOf = (acc) => new Set([acc.app_user_id, acc.ig_user_id].filter(Boolean).map(String));

async function pollComments(acc, api, automations) {
  const commentAutos = automations.filter((a) => a.on_comments);
  if (!commentAutos.length) return;

  const myIds = myIdsOf(acc);
  const now = Date.now();
  const media = (await api.listMedia(MEDIA_LIMIT)).data || [];
  // Posts picked in an automation may be older than the recent ones listed
  for (const id of new Set(commentAutos.map((a) => a.media_id).filter(Boolean))) {
    if (!media.some((m) => m.id === id)) media.push(await api.getMedia(id).catch(() => ({ id, comments_count: -1 })));
  }

  for (const md of media) {
    const relevant = commentAutos.filter((a) => !a.media_id || a.media_id === md.id);
    if (!relevant.length) continue;

    const cache = await one('SELECT * FROM media_cache WHERE media_id = $1', [md.id]);
    // Only scan when the count changed, or every 5 min as a safety net
    const force = !cache || now - cache.checked_at > 5 * MIN;
    if (!force && cache.comments_count === md.comments_count) continue;

    const scanStart = Date.now();
    const stopBefore = Math.max(
      Math.min(...relevant.map((a) => a.activated_at)),
      (cache?.checked_at || 0) - OVERLAP,
      now - 7 * DAY + 30 * MIN // after 7 days Meta no longer allows private replies
    );

    // Comments come newest first: paginate until we pass what was already scanned
    const found = [];
    let after;
    for (let page = 0; page < 40; page++) {
      const res = await api.listComments(md.id, after);
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
      if (at < stopBefore || myIds.has(String(c.from?.id)) || c.username === acc.username) continue;
      const a = relevant.find((x) => at >= x.activated_at && matches(x, c.text));
      if (!a) continue;
      await enqueue(acc, {
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

async function pollConversations(acc, api, automations, hasWaiting) {
  const dmAutos = automations.filter((a) => a.on_dms || a.on_stories);
  if (!dmAutos.length && !hasWaiting) return;

  const myIds = myIdsOf(acc);
  const now = Date.now();
  const stopBefore = Math.max((acc.conv_watermark || now - DAY) - OVERLAP, now - DAY);

  // Conversations come most recently updated first
  const messages = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const res = await api.listConversations(after);
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
    const linkEvent = `${acc.id}:link:${m.id}`;

    // Button tap (a quick reply arrives as a message with the button title)
    const w = await one('SELECT * FROM waiting WHERE account_id = $1 AND igsid = $2', [acc.id, userId]);
    if (w) {
      const a = await one('SELECT * FROM automations WHERE id = $1', [w.automation_id]);
      if (a && normalize(text) === normalize(a.button_title)) {
        await tx(async (c) => {
          await c.query(
            `INSERT INTO queue (event_id, account_id, kind, automation_id, source, user_id, username, event_at, deadline, next_at, created_at)
             VALUES ($1, $2, 'link', $3, 'click', $4, $5, $6, $7, $8, $8) ON CONFLICT (event_id) DO NOTHING`,
            [linkEvent, acc.id, a.id, userId, username || null, at, at + DAY - 10 * MIN, Date.now()]
          );
          await c.query('DELETE FROM waiting WHERE account_id = $1 AND igsid = $2', [acc.id, userId]);
        });
        log('info', `[@${acc.username}] ${who(username, userId)} tapped the button — link queued`, a.id);
        continue;
      }
    }
    if (await one('SELECT 1 AS x FROM queue WHERE event_id = $1', [linkEvent])) continue;

    const isStoryReply = !!m.story?.reply_to;
    const a = dmAutos.find((x) => (isStoryReply ? x.on_stories : x.on_dms) && at >= x.activated_at && matches(x, text));
    if (!a) continue;
    await enqueue(acc, {
      eventId: `msg:${m.id}`, kind: 'first', automationId: a.id, source: isStoryReply ? 'story' : 'dm',
      userId, username, eventAt: at, deadline: at + DAY - 10 * MIN,
    });
  }

  await run('UPDATE accounts SET conv_watermark = $1 WHERE id = $2', [now, acc.id]);
}

async function pollAccount(acc) {
  const automations = await all('SELECT * FROM automations WHERE active = true AND account_id = $1', [acc.id]);
  const hasWaiting = !!(await one('SELECT 1 AS x FROM waiting WHERE account_id = $1 LIMIT 1', [acc.id]));
  if (!automations.length && !hasWaiting) return;

  const api = forToken(acc.token);
  await pollConversations(acc, api, automations, hasWaiting);
  await pollComments(acc, api, automations);
}

const errorStreak = new Map();
let lastMaintenance = 0;

async function pollLoop() {
  const accounts = await all('SELECT * FROM accounts WHERE token IS NOT NULL').catch(() => []);
  for (const acc of accounts) {
    try {
      await pollAccount(acc);
      if (acc.last_error) await run('UPDATE accounts SET last_error = NULL WHERE id = $1', [acc.id]);
      errorStreak.delete(acc.id);
    } catch (err) {
      await run('UPDATE accounts SET last_error = $1 WHERE id = $2', [err.message, acc.id]).catch(() => {});
      const n = errorStreak.get(acc.id) || 0;
      if (n % 10 === 0) log('error', `[@${acc.username}] Could not check Instagram: ${err.message}`);
      errorStreak.set(acc.id, n + 1);
    }
  }
  status.lastRun = Date.now();
  if (Date.now() - lastMaintenance > HOUR) {
    lastMaintenance = Date.now();
    await refreshTokens().catch(() => {});
    cleanup().catch(() => {});
  }
  setTimeout(pollLoop, POLL_SECONDS * 1000);
}

// ---------------------------------------------------------------------------
// Worker: sends what is queued, retrying until Meta's deadline
// ---------------------------------------------------------------------------

function firstMessage(a) {
  return {
    message: {
      text: a.msg1_text,
      quick_replies: [{ content_type: 'text', title: a.button_title.slice(0, 20), payload: `AUTO_${a.id}` }],
    },
    fallback: { text: `${a.msg1_text}\n\nReply "${a.button_title}" to get it.` },
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

// Picks a public reply, avoiding the ones used most recently by this automation
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

async function send(api, recipient, { message, fallback }) {
  await humanDelay();
  try {
    return await api.sendMessage(recipient, message);
  } catch (err) {
    // Invalid parameter = Instagram rejected the button/quick reply; send a text-only version
    if (errInfo(err).code !== 100 || errInfo(err).error_subcode) throw err;
    log('warn', `Button format rejected (${err.message}); sending text only`);
    return await api.sendMessage(recipient, fallback);
  }
}

// Errors that are pointless to retry
function isPermanent(err) {
  const { code, error_subcode: sub, message = '' } = errInfo(err);
  return code === 551 || sub === 33 || sub === 2534022 || sub === 2018278 || /already (been )?(replied|sent)/i.test(message);
}

function isRateLimit(err) {
  return [4, 17, 32, 613].includes(errInfo(err).code);
}

async function firstSendsLastHour() {
  const rows = await all(
    "SELECT account_id, COUNT(*) AS n FROM queue WHERE kind = 'first' AND status = 'done' AND done_at > $1 GROUP BY account_id",
    [Date.now() - HOUR]
  );
  return Object.fromEntries(rows.map((r) => [r.account_id, r.n]));
}

async function claimNext() {
  const now = Date.now();
  const sent = await firstSendsLastHour();
  const overBudget = Object.keys(sent).filter((id) => sent[id] >= MAX_SENDS_PER_HOUR).map(Number);
  // Locks the row for 3 min: another instance (if any) skips it
  return one(
    `UPDATE queue SET locked_until = $1 WHERE id = (
       SELECT id FROM queue
       WHERE status = 'pending' AND next_at <= $2 AND locked_until < $2
         AND (kind = 'link' OR NOT (account_id = ANY($3::bigint[])))
       ORDER BY (kind = 'link') DESC, event_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [now + 3 * MIN, now, overBudget]
  );
}

async function finish(item, statusValue, error = null) {
  await run('UPDATE queue SET status = $1, last_error = $2, done_at = $3, locked_until = 0 WHERE id = $4',
    [statusValue, error, Date.now(), item.id]);
}

async function postpone(item, ms, error) {
  await run('UPDATE queue SET next_at = $1, last_error = $2, locked_until = 0 WHERE id = $3',
    [Math.min(Date.now() + ms, item.deadline - MIN), error, item.id]);
}

async function processItem(item) {
  const person = who(item.username, item.user_id);
  if (Date.now() > item.deadline) {
    await finish(item, 'failed', "Meta's reply deadline has passed");
    return log('error', `Deadline passed — ${person} did not get the message`, item.automation_id);
  }
  const a = await one('SELECT * FROM automations WHERE id = $1', [item.automation_id]);
  if (!a) return finish(item, 'skipped', 'Automation deleted');
  const acc = await one('SELECT * FROM accounts WHERE id = $1', [item.account_id]);
  // Disconnected account: keep the item waiting (it is sent once the account is reconnected)
  if (!acc?.token) return postpone(item, 10 * MIN, 'Account disconnected — waiting for reconnection');
  const api = forToken(acc.token);

  try {
    if (item.kind === 'link') {
      await send(api, { id: item.user_id }, linkMessage(a));
      await tx(async (c) => {
        await c.query("UPDATE queue SET status = 'done', done_at = $1, locked_until = 0, last_error = NULL WHERE id = $2", [Date.now(), item.id]);
        await c.query('UPDATE runs SET clicked = true WHERE id = (SELECT MAX(id) FROM runs WHERE automation_id = $1 AND user_id = $2)', [a.id, item.user_id]);
      });
      return log('info', `[@${acc.username}] Link sent to ${person}`, a.id);
    }

    // Step 2: public reply to the comment ("check your DMs")
    let retryError = null;
    if (item.comment_id && !item.public_done) {
      try {
        await humanDelay();
        await api.replyToComment(item.comment_id, pickReply(a));
        log('info', `[@${acc.username}] Replied to ${person}'s comment`, a.id);
      } catch (err) {
        if (!isPermanent(err)) retryError = err;
        else log('error', `[@${acc.username}] Could not reply to ${person}'s comment: ${err.message}`, a.id);
      }
      if (!retryError) {
        item.public_done = true;
        await run('UPDATE queue SET public_done = true WHERE id = $1', [item.id]);
      }
    }

    // Step 3: first DM (does not wait for the public reply to succeed)
    let dmNote = null;
    if (!item.dm_done) {
      let dmFinished = true; // sent, not repeated, or permanently failed
      const recent = await one(
        `SELECT 1 AS x FROM runs WHERE automation_id = $1 AND at > $2
           AND (user_id = $3 OR alt_id = $3 OR (username IS NOT NULL AND username = $4))`,
        [a.id, Date.now() - COOLDOWN_HOURS * HOUR, item.user_id || '-', item.username || null]
      );
      if (recent) {
        dmNote = `DM not repeated: already received in the last ${COOLDOWN_HOURS}h`;
        log('info', `[@${acc.username}] ${person} already got this DM in the last ${COOLDOWN_HOURS}h — not repeated`, a.id);
      } else {
        try {
          const recipient = item.comment_id ? { comment_id: item.comment_id } : { id: item.user_id };
          const res = await send(api, recipient, firstMessage(a));
          const igsid = res?.recipient_id || item.user_id;
          const now = Date.now();
          await tx(async (c) => {
            await c.query('UPDATE queue SET user_id = COALESCE(user_id, $1) WHERE id = $2', [igsid, item.id]);
            await c.query('INSERT INTO runs (automation_id, user_id, alt_id, username, source, at) VALUES ($1, $2, $3, $4, $5, $6)',
              [a.id, igsid, item.user_id || null, item.username || null, item.source, now]);
            await c.query(`INSERT INTO waiting (account_id, igsid, automation_id, at) VALUES ($1, $2, $3, $4)
              ON CONFLICT (account_id, igsid) DO UPDATE SET automation_id = excluded.automation_id, at = excluded.at`, [acc.id, igsid, a.id, now]);
          });
          log('info', `[@${acc.username}] First DM sent to ${person} (${item.source})`, a.id);
        } catch (err) {
          if (isPermanent(err)) {
            dmNote = `DM failed: ${err.message}`;
            log('error', `[@${acc.username}] Could not send the DM to ${person}: ${err.message}`, a.id);
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
      const failed = dmNote?.startsWith('DM failed');
      const skipped = !item.comment_id && dmNote && !failed;
      return finish(item, failed ? 'failed' : skipped ? 'skipped' : 'done', dmNote);
    }
    if (retryError) throw retryError;
  } catch (err) {
    if (isPermanent(err)) {
      await finish(item, 'failed', err.message);
      return log('error', `[@${acc.username}] Could not send to ${person}: ${err.message}`, a.id);
    }
    const attempts = item.attempts + (isRateLimit(err) ? 0 : 1);
    const wait = isRateLimit(err) ? 10 * MIN : RETRY_STEPS[Math.min(attempts - 1, RETRY_STEPS.length - 1)];
    await run('UPDATE queue SET attempts = $1, next_at = $2, last_error = $3, locked_until = 0 WHERE id = $4',
      [attempts, Math.min(Date.now() + wait, item.deadline - MIN), err.message, item.id]);
    if (attempts <= 1) log('warn', `[@${acc.username}] Sending to ${person} failed, will retry: ${err.message}`, a.id);
  }
}

async function workerLoop() {
  for (;;) {
    let item = null;
    try {
      item = await claimNext();
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
  return { pending: by.pending || 0, failed24h: by.failed || 0, maxPerHour: MAX_SENDS_PER_HOUR, sentLastHour: await firstSendsLastHour() };
}

export function start() {
  log('info', `Engine started (checking every ${POLL_SECONDS}s, up to ${MAX_SENDS_PER_HOUR} first DMs/hour per account)`);
  pollLoop();
  workerLoop();
}
