// Public pages required by Meta for app review
const APP_NAME = process.env.LEGAL_APP_NAME || 'InstaDM';
const OWNER = process.env.LEGAL_OWNER || '[set LEGAL_OWNER]';
const EMAIL = process.env.LEGAL_EMAIL || '[set LEGAL_EMAIL]';
const UPDATED = '2026-10-10';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const app = esc(APP_NAME);
const owner = esc(OWNER);
const contact = `<a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${app}</title>
<style>
  :root { --bg: #fff; --text: #1d1d22; --muted: #66666f; --border: #e4e4ea; --link: #b8327a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111114; --text: #ececf1; --muted: #a0a0ab; --border: #2c2c34; --link: #f07ab8; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 24px 0 4px; }
  h2 { font-size: 19px; margin-top: 32px; }
  .muted { color: var(--muted); font-size: 14px; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  a { color: var(--link); }
</style>
</head>
<body><main>
<nav><strong>${app}</strong><a href="/privacy">Privacy Policy</a><a href="/data-deletion">Data Deletion</a><a href="/terms">Terms of Service</a></nav>
${body}
</main></body></html>`;
}

const scope = `${app} is a private, non-commercial tool built and used only by ${owner} to automate replies on Instagram professional accounts that ${owner} owns (a founder account and a product account). It is not sold, licensed or offered to anyone else, and it is never used to manage accounts owned by third parties.`;

export const privacyPage = () => page('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>${scope}</p>

<h2>Data we process</h2>
<p><strong>From the connected accounts (owned by ${owner}):</strong></p>
<ul>
  <li>Instagram account ID, username and profile picture;</li>
  <li>the access token issued by Meta, required for the integration;</li>
  <li>media IDs and comment counts of the account's own posts.</li>
</ul>
<p><strong>From people who comment on, reply to stories of, or message those accounts:</strong></p>
<ul>
  <li>Instagram-scoped user ID (IGSID) and username;</li>
  <li>comment or message ID and timestamp;</li>
  <li>the <strong>text</strong> of comments and messages is read only to check whether it contains a configured keyword. It is <strong>never stored</strong>.</li>
</ul>

<h2>How we use it</h2>
<p>Only to: (1) detect comments, story replies or messages that contain a configured keyword; (2) post a reply to that comment; (3) send the content the person asked for by direct message; (4) avoid sending the same message twice and keep aggregate send and click counts.</p>
<p>We do not sell, rent or share data with third parties, do not use it for advertising and do not build user profiles. Messages are only sent to people who interacted with the account first, within the messaging windows allowed by Meta.</p>

<h2>Storage and retention</h2>
<ul>
  <li>Data is stored in an access-restricted PostgreSQL database (Supabase) and on the application server, accessible only to ${owner}.</li>
  <li>Send queue: up to 30 days. Activity logs: up to 14 days. Send history (used to avoid repeated messages): up to 90 days. People waiting for a button tap: up to 24 hours.</li>
  <li>Access tokens are kept while an account is connected and deleted when it is disconnected.</li>
</ul>

<h2>Your rights</h2>
<p>You can ask for access to, correction of, or deletion of your data at any time by emailing ${contact}. See the <a href="/data-deletion">data deletion instructions</a>. You can also remove the app's access in Instagram (Settings → Apps and websites).</p>

<h2>Contact</h2>
<p>${owner} — ${contact}</p>
`);

export const deletionPage = () => page('Data Deletion', `
<h1>Data Deletion Instructions</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>To delete the data ${app} keeps about you:</p>
<ol>
  <li>Email ${contact} with the subject <strong>"Data deletion"</strong> and your Instagram username.</li>
  <li>We delete your user ID, username and send history within 30 days and confirm by email.</li>
</ol>
<p>Data is also deleted automatically: send queue within 30 days, logs within 14 days and send history within 90 days. The text of comments and messages is never stored.</p>
<p>The owner of a connected account can disconnect it in the ${app} dashboard or remove the app in Instagram (Settings → Apps and websites); its access token is then deleted.</p>
`);

export const termsPage = () => page('Terms of Service', `
<h1>Terms of Service</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>${scope}</p>
<h2>Use</h2>
<p>${app} is used in accordance with the Meta Platform Terms, the Meta Developer Policies and the Instagram Terms of Use. It only replies to people who interacted with the account first (by commenting a keyword, replying to a story or sending a message) and only within the messaging windows allowed by Meta.</p>
<h2>No commercial use</h2>
<p>${app} is not a product or service. There are no customers, subscriptions or fees, and access to the dashboard is restricted to ${owner}.</p>
<h2>Contact</h2>
<p>${owner} — ${contact}</p>
`);
