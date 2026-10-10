# Revisão do app na Meta (App Review)

Objetivo: obter **Advanced Access** para `instagram_business_basic`, `instagram_business_manage_comments` e `instagram_business_manage_messages`. Sem ele, a API só mostra comentários e mensagens de contas com papel no app.

Troque `https://SEU-DOMINIO` pela URL do app (o `APP_URL`).

---

## Parte 1: preparar (antes de enviar)

### 1.1 Variáveis no Easypanel
Adicione e faça o deploy de novo:
```
LEGAL_OWNER=Nome da empresa (razão social) ou seu nome
LEGAL_EMAIL=e-mail que você lê (vai aparecer nas páginas públicas)
```
Confira se abrem sem login:
- `https://SEU-DOMINIO/privacy`
- `https://SEU-DOMINIO/data-deletion`
- `https://SEU-DOMINIO/terms`

### 1.2 App settings → Basic (painel da Meta)
- **App icon:** imagem de 1024×1024.
- **Privacy Policy URL:** `https://SEU-DOMINIO/privacy`
- **Terms of Service URL:** `https://SEU-DOMINIO/terms`
- **User data deletion:** escolha "Data deletion instructions URL" e informe `https://SEU-DOMINIO/data-deletion`.
- **Category:** Business and pages.
- **Contact email:** o mesmo do `LEGAL_EMAIL`.
- Salve.

### 1.3 Verificação da empresa (Business Verification)
A Meta costuma exigir isso para conceder Advanced Access.
- Em App settings → Basic, conecte o app a um **Business portfolio** (business.facebook.com).
- Em Business settings → Security Center → **Start verification**, envie os dados e documentos da empresa (CNPJ, comprovante de endereço ou telefone).
- A verificação pode levar alguns dias e pode correr em paralelo com o resto.

### 1.4 Login do Instagram (obrigatório para o vídeo)
Os revisores querem ver a tela de consentimento da Meta. Por isso, o vídeo precisa usar **"Entrar com Instagram"**, não "Colar token".
- Em Use cases → Instagram API → API setup with Instagram login → **4. Set up Instagram business login** → **Business login settings**.
- Em **OAuth redirect URIs**, cadastre `https://SEU-DOMINIO/auth/callback` (o painel do InstaDM mostra a URL exata quando a conta está desconectada).
- Salve.

### 1.5 Conta de teste
- Em App roles → Roles → **Add people → Instagram Tester**, adicione uma segunda conta do Instagram.
- Aceite o convite nessa conta: instagram.com → Configurações → Apps e sites → Convites de testador.
- Com ela, teste o fluxo completo antes de gravar.

### 1.6 Pedir as permissões
- Use cases → Instagram API → **Permissions and features**.
- Em `instagram_business_basic`, `instagram_business_manage_comments` e `instagram_business_manage_messages`, clique em **Request advanced access**.

---

## Parte 2: gravar o vídeo (screencast)

O vídeo pode ser um só, cobrindo as 3 permissões, com 2–4 minutos. Grave a tela do computador e, na parte da DM, a tela do celular da conta de teste (espelhamento ou gravação do celular).

**O painel está em português: adicione legendas em inglês** (no editor de vídeo ou com textos na tela). É motivo comum de reprovação.

| # | Mostrar | Legenda em inglês |
|---|---|---|
| 1 | Painel do InstaDM desconectado | "InstaDM is an internal tool to auto-reply on our own Instagram professional account." |
| 2 | Clicar em **Entrar com Instagram**, fazer login e mostrar a **tela de permissões** da Meta; aceitar | "We log in with Instagram Business Login and grant instagram_business_basic, instagram_business_manage_comments and instagram_business_manage_messages." |
| 3 | Voltar ao painel com foto e @ da conta | "instagram_business_basic: we show the connected account's username and profile picture." |
| 4 | Criar uma automação: palavra-chave, 5 respostas, 1ª mensagem com botão, mensagem com link; salvar e ativar | "We configure a keyword, public replies, a first DM with a button and a follow-up DM with a link." |
| 5 | No celular da conta de teste, comentar a palavra-chave no post | "A user comments the keyword on our post." |
| 6 | O comentário recebe a resposta pública; mostrar a fila e a atividade no painel | "instagram_business_manage_comments: we read new comments on our own posts and publish a reply to the comment." |
| 7 | Na conta de teste, abrir a DM recebida e tocar no botão | "instagram_business_manage_messages: we send a private reply to the commenter with a button." |
| 8 | A mensagem com o link chega | "After the user taps the button, we send the requested link. Messages are only sent to users who interacted, within Meta's messaging window." |
| 9 | (Opcional) Responder a um story com a palavra-chave e mostrar a DM | "Story replies and DMs with the keyword trigger the same flow." |

---

## Parte 3: textos para colar no formulário (em inglês)

### instagram_business_basic
> InstaDM is an internal tool used only by our company to manage our own Instagram professional account. We use instagram_business_basic to identify the connected account (ID, username and profile picture shown in our dashboard) and to list our own media so we can choose which posts an automation applies to. We do not access accounts we do not own and we do not share this data with third parties.

### instagram_business_manage_comments
> We use instagram_business_manage_comments to read new comments on our own posts and detect when a user comments a keyword we configured (for example, "EBOOK"). When this happens, we publish a short public reply to that comment letting the user know we sent them a direct message. Comment text is only processed to match the keyword and is not stored. This lets us answer every interested follower promptly, even when a post receives dozens of comments per hour.

### instagram_business_manage_messages
> We use instagram_business_manage_messages to send a private reply to users who commented a configured keyword on our posts (or replied to our story or messaged us with that keyword). The first message contains a button; only after the user taps it do we send a follow-up message with the requested link. We read our conversations only to detect the button tap and keyword messages. We never send unsolicited messages: every message is a response to the user's own interaction and respects Meta's messaging windows (7 days for private replies, 24 hours for direct messages).

### App verification / test instructions
> 1. Open https://SEU-DOMINIO and log in with the dashboard password: SENHA_TEMPORARIA
> 2. The Instagram account @orafadoinfosaas is already connected (profile picture and username at the top).
> 3. An active automation named "Review" uses the keyword REVIEW.
> 4. Comment "REVIEW" on this post: LINK_DO_POST
> 5. Within about 30 seconds, the comment receives a public reply and the commenter receives a direct message with a button. Tap the button (on the Instagram mobile app; quick replies are not shown on desktop) to receive the follow-up message with the link.
> 6. The "Fila de envio" (send queue) and "Atividade" (activity log) sections of the dashboard show each step.
> Note: the dashboard is in Portuguese; the video includes English captions.

**Antes de enviar:**
- Crie uma senha temporária: troque o `APP_PASSWORD` no Easypanel e volte à senha normal depois da aprovação.
- Crie a automação "Review" com a palavra-chave `REVIEW` e deixe-a ativa.
- Coloque o link do post nas instruções.

---

## Parte 4: depois da aprovação
1. No painel da Meta, mude o app para **Live** (menu Publicar / Publish).
2. Troque o `APP_PASSWORD` de volta e desative ou exclua a automação "Review".
3. Teste com uma conta sem papel no app: a resposta no comentário, a DM e o link devem funcionar.

Se a Meta reprovar, ela informa o motivo por permissão. Traga o texto da reprovação para ajustarmos e reenviarmos.
