const VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const HOST = 'https://graph.instagram.com';

export class GraphError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function graph(token, method, path, { query = {}, body } = {}) {
  if (!token) throw new Error('Conta não conectada');
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

// Instagram Graph API calls bound to one account's token
export function forToken(token) {
  const call = (method, path, opts) => graph(token, method, path, opts);
  return {
    getMe: () => call('GET', '/me', { query: { fields: 'id,user_id,username,profile_picture_url' } }),

    listMedia: (limit = 12) =>
      call('GET', '/me/media', { query: { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,comments_count', limit } }),

    listMediaCounts: (limit = 50) => call('GET', '/me/media', { query: { fields: 'id,timestamp,comments_count', limit } }),

    // Subscribes this account to webhook events for our app
    subscribeWebhooks: () => call('POST', '/me/subscribed_apps', { query: { subscribed_fields: 'comments,messages' } }),

    getMedia: (mediaId) => call('GET', `/${mediaId}`, { query: { fields: 'id,timestamp,comments_count' } }),

    // On API v3.2+ comments come newest first; top-level only (replies via the replies field)
    listComments: (mediaId, after) =>
      call('GET', `/${mediaId}/comments`, {
        query: {
          fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}',
          limit: 50,
          ...(after ? { after } : {}),
        },
      }),

    listConversations: (after) =>
      call('GET', '/me/conversations', {
        query: {
          platform: 'instagram',
          fields: 'id,updated_time,messages.limit(10){id,created_time,from,message,story}',
          limit: 25,
          ...(after ? { after } : {}),
        },
      }),

    replyToComment: (commentId, message) => call('POST', `/${commentId}/replies`, { query: { message } }),

    // recipient: { id: IGSID } or { comment_id } (private reply to a comment)
    sendMessage: (recipient, message) => call('POST', '/me/messages', { body: { recipient, message } }),
  };
}
