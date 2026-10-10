// Páginas públicas exigidas pela Meta para a revisão do app (bilíngues: PT-BR e EN)
const APP_NAME = process.env.LEGAL_APP_NAME || 'InstaDM';
const OWNER = process.env.LEGAL_OWNER || '[defina LEGAL_OWNER]';
const EMAIL = process.env.LEGAL_EMAIL || '[defina LEGAL_EMAIL]';
const UPDATED = '2026-10-10';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(title, body) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(APP_NAME)}</title>
<style>
  :root { --bg: #fff; --text: #1d1d22; --muted: #66666f; --border: #e4e4ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111114; --text: #ececf1; --muted: #a0a0ab; --border: #2c2c34; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 19px; margin-top: 32px; }
  h3 { font-size: 16px; margin-top: 22px; }
  .muted { color: var(--muted); font-size: 14px; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 40px 0; }
  nav a { margin-right: 14px; font-size: 14px; }
  a { color: #c13584; }
</style>
</head>
<body><main>
<nav><a href="/privacy">Privacidade / Privacy</a><a href="/data-deletion">Exclusão de dados / Data deletion</a><a href="/terms">Termos / Terms</a></nav>
${body}
</main></body></html>`;
}

const contact = `<a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>`;

export const privacyPage = () => page('Política de Privacidade / Privacy Policy', `
<h1>Política de Privacidade</h1>
<p class="muted">Última atualização: ${UPDATED}</p>
<p>O ${esc(APP_NAME)} é uma ferramenta de uso interno de ${esc(OWNER)} que automatiza respostas a comentários e mensagens na conta profissional do Instagram de ${esc(OWNER)}. Não é oferecido ao público e não é usado para gerenciar contas de terceiros.</p>

<h2>Dados que tratamos</h2>
<h3>Da conta profissional conectada</h3>
<ul>
  <li>ID e nome de usuário da conta do Instagram e foto de perfil;</li>
  <li>token de acesso fornecido pela Meta (necessário para a integração);</li>
  <li>IDs e contagem de comentários das publicações da própria conta.</li>
</ul>
<h3>De pessoas que comentam ou enviam mensagens para a conta</h3>
<ul>
  <li>ID com escopo do Instagram (IGSID) e nome de usuário;</li>
  <li>ID do comentário ou da mensagem e data/hora;</li>
  <li>o <strong>texto</strong> de comentários e mensagens é lido apenas para verificar se contém uma palavra-chave configurada e <strong>não é armazenado</strong>.</li>
</ul>

<h2>Como usamos</h2>
<p>Somente para: (1) identificar comentários, respostas a stories ou mensagens que contenham uma palavra-chave configurada; (2) publicar uma resposta ao comentário; (3) enviar, por mensagem direta, o conteúdo solicitado pela pessoa; (4) evitar envios duplicados e manter estatísticas agregadas de envios e cliques.</p>
<p>Não vendemos, alugamos ou compartilhamos dados com terceiros, não usamos os dados para publicidade e não criamos perfis de usuários.</p>

<h2>Armazenamento e retenção</h2>
<ul>
  <li>Dados ficam em banco de dados com acesso restrito (Supabase/PostgreSQL) e no servidor da aplicação, acessíveis apenas por ${esc(OWNER)}.</li>
  <li>Fila de envios: até 30 dias. Registros de atividade: até 14 dias. Histórico de envios (para não repetir mensagens): até 90 dias. Pessoas aguardando o clique no botão: até 24 horas.</li>
  <li>O token de acesso é mantido enquanto a conta estiver conectada e é apagado ao desconectar.</li>
</ul>

<h2>Seus direitos (LGPD)</h2>
<p>Você pode solicitar acesso, correção ou exclusão dos seus dados a qualquer momento pelo e-mail ${contact}. Veja também a página de <a href="/data-deletion">exclusão de dados</a>. Você pode ainda remover o acesso do aplicativo nas configurações do Instagram (Configurações → Apps e sites).</p>

<h2>Contato</h2>
<p>${esc(OWNER)} — ${contact}</p>

<hr>

<h1>Privacy Policy</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>${esc(APP_NAME)} is an internal tool operated by ${esc(OWNER)} that automates replies to comments and messages on ${esc(OWNER)}'s own Instagram professional account. It is not offered to the public and is not used to manage third-party accounts.</p>

<h2>Data we process</h2>
<h3>From the connected professional account</h3>
<ul>
  <li>Instagram account ID, username and profile picture;</li>
  <li>the access token provided by Meta (required for the integration);</li>
  <li>media IDs and comment counts of the account's own posts.</li>
</ul>
<h3>From people who comment on or message the account</h3>
<ul>
  <li>Instagram-scoped ID (IGSID) and username;</li>
  <li>comment or message ID and timestamp;</li>
  <li>the <strong>text</strong> of comments and messages is read only to check whether it contains a configured keyword and is <strong>not stored</strong>.</li>
</ul>

<h2>How we use it</h2>
<p>Only to: (1) detect comments, story replies or messages containing a configured keyword; (2) post a reply to the comment; (3) send the requested content via direct message; (4) prevent duplicate messages and keep aggregate send/click statistics.</p>
<p>We do not sell, rent or share data with third parties, do not use it for advertising and do not build user profiles.</p>

<h2>Storage and retention</h2>
<ul>
  <li>Data is kept in an access-restricted database (Supabase/PostgreSQL) and on the application server, accessible only to ${esc(OWNER)}.</li>
  <li>Send queue: up to 30 days. Activity logs: up to 14 days. Send history (to avoid repeated messages): up to 90 days. People awaiting a button tap: up to 24 hours.</li>
  <li>The access token is kept while the account is connected and deleted upon disconnection.</li>
</ul>

<h2>Your rights</h2>
<p>You may request access to, correction or deletion of your data at any time at ${contact}. See also the <a href="/data-deletion">data deletion</a> page. You can also remove the app's access in Instagram settings (Settings → Apps and websites).</p>

<h2>Contact</h2>
<p>${esc(OWNER)} — ${contact}</p>
`);

export const deletionPage = () => page('Exclusão de dados / Data deletion', `
<h1>Exclusão de dados</h1>
<p>Para excluir os dados que o ${esc(APP_NAME)} mantém sobre você:</p>
<ol>
  <li>Envie um e-mail para ${contact} com o assunto <strong>"Exclusão de dados"</strong> e o seu nome de usuário do Instagram.</li>
  <li>Excluiremos seu ID, nome de usuário e histórico de envios em até 30 dias e confirmaremos por e-mail.</li>
</ol>
<p>Os dados também são apagados automaticamente: fila em até 30 dias, registros em até 14 dias e histórico de envios em até 90 dias. O texto de comentários e mensagens nunca é armazenado.</p>
<p>Se você é o titular da conta conectada, basta desconectar a conta no painel ou remover o app em Instagram → Configurações → Apps e sites; o token de acesso é apagado.</p>

<hr>

<h1>Data deletion</h1>
<p>To delete the data ${esc(APP_NAME)} keeps about you:</p>
<ol>
  <li>Email ${contact} with the subject <strong>"Data deletion"</strong> and your Instagram username.</li>
  <li>We will delete your ID, username and send history within 30 days and confirm by email.</li>
</ol>
<p>Data is also deleted automatically: queue within 30 days, logs within 14 days and send history within 90 days. Comment and message text is never stored.</p>
<p>If you own the connected account, disconnect it in the dashboard or remove the app in Instagram → Settings → Apps and websites; the access token is deleted.</p>
`);

export const termsPage = () => page('Termos de Uso / Terms of Service', `
<h1>Termos de Uso</h1>
<p class="muted">Última atualização: ${UPDATED}</p>
<p>O ${esc(APP_NAME)} é uma ferramenta interna de ${esc(OWNER)}, usada exclusivamente para automatizar respostas na conta profissional do Instagram de ${esc(OWNER)}. O uso segue as Políticas da Plataforma Meta e os Termos de Uso do Instagram. As mensagens são enviadas apenas a pessoas que interagiram com a conta (comentando uma palavra-chave, respondendo a um story ou enviando mensagem), dentro das janelas permitidas pela Meta. Dúvidas: ${contact}.</p>
<hr>
<h1>Terms of Service</h1>
<p class="muted">Last updated: ${UPDATED}</p>
<p>${esc(APP_NAME)} is an internal tool of ${esc(OWNER)}, used exclusively to automate replies on ${esc(OWNER)}'s own Instagram professional account. Use follows the Meta Platform Policies and Instagram Terms of Use. Messages are only sent to people who interacted with the account (commenting a keyword, replying to a story or sending a message), within the messaging windows allowed by Meta. Questions: ${contact}.</p>
`);
