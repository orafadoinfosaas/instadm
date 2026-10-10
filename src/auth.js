import { getSetting, setSetting, log } from './db.js';

// Login com Instagram (Instagram API with Instagram Login), usando o app próprio na Meta
const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const DAY = 24 * 3600 * 1000;

function requireApp() {
  if (!APP_ID || !APP_SECRET) throw new Error('INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET não configurados');
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

async function exchangeLongLived(shortToken) {
  requireApp();
  const qs = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: APP_SECRET, access_token: shortToken });
  return getJson(await fetch(`https://graph.instagram.com/access_token?${qs}`));
}

async function saveToken({ access_token, expires_in }) {
  const now = Date.now();
  await setSetting('ig_token', access_token);
  await setSetting('ig_token_expires_at', now + (Number(expires_in) || 60 * 24 * 3600) * 1000);
  await setSetting('ig_token_refreshed_at', now);
  tokenCache.at = 0;
}

// Troca o "code" do OAuth por um token de 60 dias
export async function handleCallback(code, redirectUri) {
  requireApp();
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code: code.replace(/#_$/, ''),
  });
  const data = await getJson(await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body }));
  const short = data.data?.[0] || data;
  await saveToken(await exchangeLongLived(short.access_token));
}

// Token colado manualmente (gerado no painel da Meta): tenta converter para 60 dias, senão usa como está
export async function saveManualToken(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Token vazio');
  try {
    await saveToken(await exchangeLongLived(token));
  } catch {
    await saveToken({ access_token: token, expires_in: 60 * 24 * 3600 });
  }
}

export async function clearToken() {
  for (const k of ['ig_token', 'ig_token_expires_at', 'ig_token_refreshed_at']) await setSetting(k, null);
  tokenCache.at = 0;
}

const tokenCache = { token: null, at: 0 };
export async function getToken() {
  if (Date.now() - tokenCache.at < 60 * 1000) return tokenCache.token;
  tokenCache.token = await getSetting('ig_token');
  tokenCache.at = Date.now();
  return tokenCache.token;
}

export async function tokenInfo() {
  const expiresAt = Number(await getSetting('ig_token_expires_at')) || null;
  return { connected: !!(await getToken()), expiresAt };
}

// Renova o token quando faltam menos de 15 dias (precisa ter mais de 24h e não estar vencido)
export async function refreshIfNeeded() {
  const token = await getToken();
  if (!token) return;
  const expiresAt = Number(await getSetting('ig_token_expires_at')) || 0;
  const refreshedAt = Number(await getSetting('ig_token_refreshed_at')) || 0;
  if (expiresAt - Date.now() > 15 * DAY || Date.now() - refreshedAt < DAY) return;
  try {
    const qs = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
    await saveToken(await getJson(await fetch(`https://graph.instagram.com/refresh_access_token?${qs}`)));
    log('info', 'Token do Instagram renovado por mais 60 dias');
  } catch (err) {
    log('error', `Falha ao renovar o token do Instagram: ${err.message}`);
  }
}
