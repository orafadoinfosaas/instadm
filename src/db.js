import pg from 'pg';

// BIGINT (timestamps in ms, COUNT) comes back as number instead of string
pg.types.setTypeParser(20, (v) => Number(v));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (Supabase connection string)');

let driver;
if (url.startsWith('pglite:')) {
  // Embedded Postgres, used only for local tests
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(url.slice('pglite:'.length) || undefined);
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));
  driver = {
    query: (sql, params) => serial(() => lite.query(sql, params)),
    tx: (fn) => serial(() => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p) }))),
  };
} else {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (err) => console.error('[db]', err.message));
  driver = {
    query: (sql, params) => pool.query(sql, params),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export const all = async (sql, params = []) => (await driver.query(sql, params)).rows;
export const one = async (sql, params = []) => (await driver.query(sql, params)).rows[0] ?? null;
export const run = async (sql, params = []) => {
  const r = await driver.query(sql, params);
  return r.rowCount ?? r.affectedRows ?? 0;
};
// fn receives { query } and runs everything in one transaction
export const tx = (fn) => driver.tx(fn);

const TABLES = ['settings', 'accounts', 'automations', 'waiting', 'runs', 'media_cache', 'queue', 'logs'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Connected Instagram professional accounts (token is null when disconnected)
  CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,
    ig_user_id TEXT UNIQUE NOT NULL,
    app_user_id TEXT,
    username TEXT NOT NULL,
    profile_picture_url TEXT,
    token TEXT,
    token_expires_at BIGINT,
    token_refreshed_at BIGINT,
    conv_watermark BIGINT,
    last_error TEXT,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS automations (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT false,
    activated_at BIGINT,
    on_comments BOOLEAN NOT NULL DEFAULT true,
    on_stories BOOLEAN NOT NULL DEFAULT false,
    on_dms BOOLEAN NOT NULL DEFAULT false,
    keywords TEXT NOT NULL,
    match_mode TEXT NOT NULL DEFAULT 'contains',
    media_id TEXT,
    public_replies TEXT,
    msg1_text TEXT NOT NULL,
    button_title TEXT NOT NULL,
    msg2_text TEXT NOT NULL,
    link_url TEXT NOT NULL,
    link_button_title TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- People who got the first DM and have not tapped the button yet
  CREATE TABLE IF NOT EXISTS waiting (
    account_id BIGINT NOT NULL,
    igsid TEXT NOT NULL,
    automation_id BIGINT NOT NULL,
    at BIGINT NOT NULL,
    PRIMARY KEY (account_id, igsid)
  );

  -- Completed first DMs, for cooldown and stats
  CREATE TABLE IF NOT EXISTS runs (
    id BIGSERIAL PRIMARY KEY,
    automation_id BIGINT NOT NULL,
    user_id TEXT NOT NULL,
    alt_id TEXT,
    username TEXT,
    source TEXT NOT NULL,
    clicked BOOLEAN NOT NULL DEFAULT false,
    at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_user ON runs (automation_id, user_id, at);

  CREATE TABLE IF NOT EXISTS media_cache (
    media_id TEXT PRIMARY KEY,
    comments_count INTEGER NOT NULL,
    checked_at BIGINT NOT NULL DEFAULT 0
  );

  -- Persistent send queue: every matching comment/message lands here and only leaves
  -- once sent or past Meta's deadline. Unique event_id prevents duplicates.
  CREATE TABLE IF NOT EXISTS queue (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT UNIQUE NOT NULL,
    account_id BIGINT,
    kind TEXT NOT NULL,
    automation_id BIGINT NOT NULL,
    source TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    comment_id TEXT,
    event_at BIGINT NOT NULL,
    deadline BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at BIGINT NOT NULL,
    locked_until BIGINT NOT NULL DEFAULT 0,
    public_done BOOLEAN NOT NULL DEFAULT false,
    dm_done BOOLEAN NOT NULL DEFAULT false,
    last_error TEXT,
    created_at BIGINT NOT NULL,
    done_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS queue_due ON queue (status, next_at);

  CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL,
    level TEXT NOT NULL,
    automation_id BIGINT,
    message TEXT NOT NULL
  )
`;

// Upgrades databases created by earlier single-account versions
const UPGRADES = [
  'ALTER TABLE automations ADD COLUMN IF NOT EXISTS account_id BIGINT',
  'ALTER TABLE queue ADD COLUMN IF NOT EXISTS account_id BIGINT',
  'ALTER TABLE queue ADD COLUMN IF NOT EXISTS dm_done BOOLEAN NOT NULL DEFAULT false',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS alt_id TEXT',
  'ALTER TABLE runs ADD COLUMN IF NOT EXISTS username TEXT',
  'DROP TABLE IF EXISTS pending',
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS webhook_status TEXT',
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_webhook_at BIGINT',
];

async function migrateLegacyAccount() {
  const token = await getSetting('ig_token');
  if (token) {
    const profile = JSON.parse((await getSetting('profile')) || 'null');
    if (profile?.user_id) {
      const acc = await one(
        `INSERT INTO accounts (ig_user_id, app_user_id, username, profile_picture_url, token, token_expires_at, token_refreshed_at, conv_watermark, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (ig_user_id) DO UPDATE SET token = excluded.token RETURNING id`,
        [String(profile.user_id), profile.id || null, profile.username, profile.profile_picture_url || null, token,
          Number(await getSetting('ig_token_expires_at')) || Date.now(), Number(await getSetting('ig_token_refreshed_at')) || Date.now(),
          Number(await getSetting('conv_watermark')) || null, Date.now()]
      );
      await run('UPDATE automations SET account_id = $1 WHERE account_id IS NULL', [acc.id]);
      await run('UPDATE queue SET account_id = $1 WHERE account_id IS NULL', [acc.id]);
    }
  }
  for (const k of ['ig_token', 'ig_token_expires_at', 'ig_token_refreshed_at', 'profile', 'conv_watermark', 'connected_account_id', 'auth_config_id']) {
    await setSetting(k, null);
  }
}

export async function migrate() {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await run(stmt);
  for (const stmt of UPGRADES) await run(stmt);
  await migrateLegacyAccount();
  // RLS on with no policies: Supabase's public API (anon key) cannot read anything.
  // The app connects as the table owner, so it is not affected.
  for (const t of TABLES) await run(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
}

export async function getSetting(key) {
  return (await one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;
}

export async function setSetting(key, value) {
  if (value === null || value === undefined) await run('DELETE FROM settings WHERE key = $1', [key]);
  else await run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

export async function log(level, message, automationId = null) {
  console.log(`[${level}]${automationId ? ` #${automationId}` : ''} ${message}`);
  await run('INSERT INTO logs (at, level, automation_id, message) VALUES ($1, $2, $3, $4)', [Date.now(), level, automationId, message])
    .catch((err) => console.error('[db] log:', err.message));
}

export async function cleanup() {
  const day = 24 * 3600 * 1000;
  await run('DELETE FROM waiting WHERE at < $1', [Date.now() - day]);
  await run("DELETE FROM queue WHERE status <> 'pending' AND created_at < $1", [Date.now() - 30 * day]);
  await run('DELETE FROM logs WHERE at < $1', [Date.now() - 14 * day]);
  await run('DELETE FROM runs WHERE at < $1', [Date.now() - 90 * day]);
}
