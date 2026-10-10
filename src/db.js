import pg from 'pg';

// BIGINT (timestamps em ms, COUNT) volta como number em vez de string
pg.types.setTypeParser(20, (v) => Number(v));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL não configurada (string de conexão do Supabase)');

let driver;
if (url.startsWith('pglite:')) {
  // Postgres embutido, usado só nos testes locais
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
// fn recebe { query } e roda tudo numa transação
export const tx = (fn) => driver.tx(fn);

const TABLES = ['settings', 'automations', 'pending', 'runs', 'media_cache', 'queue', 'logs'];

export async function migrate() {
  for (const stmt of `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS automations (
      id BIGSERIAL PRIMARY KEY,
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

    -- Quem recebeu a 1ª mensagem e ainda não tocou no botão
    CREATE TABLE IF NOT EXISTS pending (
      igsid TEXT PRIMARY KEY,
      automation_id BIGINT NOT NULL,
      at BIGINT NOT NULL
    );

    -- Envios concluídos da 1ª mensagem, para cooldown e estatísticas
    CREATE TABLE IF NOT EXISTS runs (
      id BIGSERIAL PRIMARY KEY,
      automation_id BIGINT NOT NULL,
      user_id TEXT NOT NULL,
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

    -- Fila persistente: todo comentário/mensagem que bate com uma automação entra aqui
    -- e só sai enviado ou com o prazo da Meta vencido. event_id único evita duplicidade.
    CREATE TABLE IF NOT EXISTS queue (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT UNIQUE NOT NULL,
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
  `.split(';').map((s) => s.trim()).filter(Boolean)) {
    await run(stmt);
  }
  await run('ALTER TABLE queue ADD COLUMN IF NOT EXISTS dm_done BOOLEAN NOT NULL DEFAULT false');
  // O id do autor do comentário pode diferir do id da DM: guarda os dois e o @ para o cooldown
  await run('ALTER TABLE runs ADD COLUMN IF NOT EXISTS alt_id TEXT');
  await run('ALTER TABLE runs ADD COLUMN IF NOT EXISTS username TEXT');
  // RLS ligado e sem políticas: a API pública do Supabase (anon key) não acessa nada.
  // O app conecta como dono das tabelas, então não é afetado.
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
  await run('DELETE FROM pending WHERE at < $1', [Date.now() - day]);
  await run("DELETE FROM queue WHERE status <> 'pending' AND created_at < $1", [Date.now() - 30 * day]);
  await run('DELETE FROM logs WHERE at < $1', [Date.now() - 14 * day]);
}
