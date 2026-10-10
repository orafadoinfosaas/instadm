import { all, one, run, log } from './db.js';
import { forToken } from './ig.js';

// Instagram API with Instagram Login, using our own Meta app
const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const DAY = 24 * 3600 * 1000;

function requireApp() {
  if (!APP_ID || !APP_SECRET) throw new Error('INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are not set');
}

export function authorizeUrl(redirectUri, state) {
  requireApp();
  const qs = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
    enable_fb_login: '0',
    // Always show the login screen so a different account can be picked
    force_reauth: 'true',
  });
  return `https://www.instagram.com/oauth/authorize?${qs}`;
}

async function getJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.error_message) {
    const e = data.error || {};
    throw new Error(data.error_message || e.message || `HTTP ${res.status}`);
  }
  return data;
}

// Exchanges the OAuth code for a 60-day token and saves (or updates) the account
export async function handleCallback(code, redirectUri) {
  requireApp();
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code: code.replace(/#_$/, ''),
  });
  const short = await getJson(await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body }));
  const shortToken = (short.data?.[0] || short).access_token;
  const qs = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: APP_SECRET, access_token: shortToken });
  const long = await getJson(await fetch(`https://graph.instagram.com/access_token?${qs}`));
  if (!long.access_token) throw new Error('Meta did not return an access token');

  const me = await forToken(long.access_token).getMe();
  const now = Date.now();
  const expiresAt = now + (Number(long.expires_in) || 60 * 24 * 3600) * 1000;
  const acc = await one(
    `INSERT INTO accounts (ig_user_id, app_user_id, username, profile_picture_url, token, token_expires_at, token_refreshed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (ig_user_id) DO UPDATE SET app_user_id = excluded.app_user_id, username = excluded.username,
       profile_picture_url = excluded.profile_picture_url, token = excluded.token,
       token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at, last_error = NULL
     RETURNING *`,
    [String(me.user_id || me.id), me.id ? String(me.id) : null, me.username, me.profile_picture_url || null, long.access_token, expiresAt, now]
  );
  log('info', `Account @${acc.username} connected`);
  return acc;
}

export async function disconnect(accountId) {
  const acc = await one('UPDATE accounts SET token = NULL, token_expires_at = NULL WHERE id = $1 RETURNING username', [accountId]);
  if (acc) log('info', `Account @${acc.username} disconnected`);
}

// Refreshes tokens with less than 15 days left (must be over 24h old and not expired)
export async function refreshTokens() {
  const accounts = await all('SELECT * FROM accounts WHERE token IS NOT NULL');
  for (const acc of accounts) {
    if (acc.token_expires_at - Date.now() > 15 * DAY || Date.now() - acc.token_refreshed_at < DAY) continue;
    try {
      const qs = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: acc.token });
      const data = await getJson(await fetch(`https://graph.instagram.com/refresh_access_token?${qs}`));
      if (!data.access_token) throw new Error('Meta did not return an access token');
      const now = Date.now();
      await run('UPDATE accounts SET token = $1, token_expires_at = $2, token_refreshed_at = $3 WHERE id = $4',
        [data.access_token, now + (Number(data.expires_in) || 60 * 24 * 3600) * 1000, now, acc.id]);
      log('info', `Token for @${acc.username} renewed for 60 more days`);
    } catch (err) {
      log('error', `Could not renew the token for @${acc.username}: ${err.message}. Reconnect the account.`);
    }
  }
}
