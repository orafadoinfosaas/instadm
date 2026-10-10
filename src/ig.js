import { getToken } from './auth.js';

const VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const HOST = 'https://graph.instagram.com';

export class GraphError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function graph(method, path, { query = {}, body } = {}) {
  const token = await getToken();
  if (!token) throw new Error('Instagram não conectado');

  const qs = new URLSearchParams(query);
  const res = await fetch(`${HOST}/${VERSION}${path}${qs.size ? `?${qs}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  if (res.status >= 400 || data?.error) {
    const e = data?.error || {};
    throw new GraphError(`${e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`, res.status, data);
  }
  return data;
}

export const getMe = () => graph('GET', '/me', { query: { fields: 'id,user_id,username,profile_picture_url' } });

export const listMedia = (limit = 12) =>
  graph('GET', '/me/media', { query: { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,comments_count', limit } });

export const getMedia = (mediaId) =>
  graph('GET', `/${mediaId}`, { query: { fields: 'id,timestamp,comments_count' } });

// Na API v3.2+ os comentários vêm do mais novo para o mais antigo; só os de primeiro nível
export const listComments = (mediaId, after) =>
  graph('GET', `/${mediaId}/comments`, {
    query: {
      fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}',
      limit: 50,
      ...(after ? { after } : {}),
    },
  });

export const listConversations = (after) =>
  graph('GET', '/me/conversations', {
    query: {
      platform: 'instagram',
      fields: 'id,updated_time,messages.limit(10){id,created_time,from,message,story}',
      limit: 25,
      ...(after ? { after } : {}),
    },
  });

export const replyToComment = (commentId, message) =>
  graph('POST', `/${commentId}/replies`, { query: { message } });

// recipient: { id: IGSID } ou { comment_id } (resposta privada a comentário)
export const sendMessage = (recipient, message) =>
  graph('POST', '/me/messages', { body: { recipient, message } });
