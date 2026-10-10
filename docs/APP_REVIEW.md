# Revisão do app na Meta (App Review)

Objetivo: obter **Advanced Access** para `instagram_business_basic`, `instagram_business_manage_comments` e `instagram_business_manage_messages`. Sem ele, a API só mostra comentários e mensagens de contas com papel no app.

**Contexto para a revisão:** o app é **pessoal e não comercial**. Ele é usado só por você, nas suas duas contas profissionais (founder e produto). Não há clientes, planos nem acesso de terceiros. Os textos abaixo deixam isso explícito, porque ajuda o revisor a entender o escopo.

Troque `https://SEU-DOMINIO` pela URL do app (o `APP_URL`).

---

## Parte 1: preparar (antes de enviar)

### 1.1 Variáveis no Easypanel
Adicione e faça o deploy de novo:
```
LEGAL_OWNER=Seu nome
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

### 1.3 Verificação (Business Verification)
A Meta costuma exigir isso para conceder Advanced Access, mesmo em uso próprio.
- Em App settings → Basic, conecte o app a um **Business portfolio** (business.facebook.com). Pode ser o portfólio da empresa dona das contas, ou um no seu nome.
- Em Business settings → Security Center → **Start verification**, envie os documentos solicitados.
- A verificação leva alguns dias e pode correr em paralelo com o resto.
- Se a Meta não pedir verificação para o seu caso, pule.

### 1.4 Login do Instagram (redirect)
- Em Use cases → Instagram API → API setup with Instagram login → **4. Set up Instagram business login** → **Business login settings**.
- Em **OAuth redirect URIs**, cadastre `https://SEU-DOMINIO/auth/callback`. O painel mostra a URL exata no rodapé da seção "Instagram accounts".
- Salve.

### 1.5 Papéis das contas
Em App roles → Roles → **Add people → Instagram Tester**, adicione:
- a conta **founder**;
- a conta do **produto**;
- uma **terceira conta** para fazer o papel de "seguidor" no vídeo (uma conta pessoal sua serve).

Aceite o convite em cada uma: instagram.com → Configurações → Apps e sites → Convites de testador.

Depois, no painel do InstaDM, clique em **Connect account** uma vez para a founder e outra para a do produto. A tela de login sempre aparece, para você escolher a conta.

### 1.6 Pedir as permissões
- Use cases → Instagram API → **Permissions and features**.
- Em `instagram_business_basic`, `instagram_business_manage_comments` e `instagram_business_manage_messages`, clique em **Request advanced access**.

---

## Parte 2: gravar o vídeo (screencast)

Um vídeo só, de 2–4 minutos, cobre as 3 permissões. Grave a tela do computador e, nas partes do Instagram, a tela do celular da conta "seguidor" (espelhamento ou gravação do celular). O painel já está em inglês, então legendas não são obrigatórias, mas as frases abaixo ajudam o revisor; use como texto na tela ou narração.

| # | Mostrar | Texto na tela (inglês) |
|---|---|---|
| 1 | Painel do InstaDM, seção "Instagram accounts" | "InstaDM is a personal, non-commercial tool I use on my own two Instagram professional accounts." |
| 2 | Clicar em **Connect account**, fazer login com a conta do produto e mostrar a **tela de permissões** da Meta; aceitar | "I log in with Instagram Business Login and grant instagram_business_basic, instagram_business_manage_comments and instagram_business_manage_messages." |
| 3 | De volta ao painel, as duas contas (founder e produto) com foto e @ | "instagram_business_basic: the dashboard shows each connected account's username and profile picture." |
| 4 | **New automation**: passar pelas etapas Setup → Keyword (escolher um post) → Comment reply → First DM → Link message; salvar e ligar | "I set a keyword, comment replies, a first DM with a button and a follow-up DM with a link." |
| 5 | No celular da conta "seguidor", comentar a palavra-chave no post | "A follower comments the keyword on my post." |
| 6 | A resposta aparece no comentário; mostrar "Send queue" e "Activity" no painel | "instagram_business_manage_comments: the app reads new comments on my own posts and replies to the comment." |
| 7 | Na conta "seguidor", abrir a DM recebida e tocar no botão | "instagram_business_manage_messages: the app sends a private reply to the commenter with a button." |
| 8 | A mensagem com o link chega | "After the follower taps the button, the app sends the requested link. Messages only go to people who interacted first, within Meta's messaging windows." |
| 9 | (Opcional) Responder a um story com a palavra-chave e mostrar a DM | "Story replies and DMs with the keyword trigger the same flow." |

---

## Parte 3: textos para colar no formulário (em inglês)

### instagram_business_basic
> InstaDM is a personal, non-commercial tool. I am the only user, and I use it exclusively on two Instagram professional accounts that I own (my founder account and my product's account). It is not sold or offered to anyone. I use instagram_business_basic to identify each connected account (ID, username and profile picture shown in the dashboard) and to list the account's own media, so I can choose which post an automation applies to.

### instagram_business_manage_comments
> I use instagram_business_manage_comments to read new comments on my own posts and detect when someone comments a keyword I configured (for example, "EBOOK"). When that happens, the app posts a short public reply to that comment letting the person know I sent them a direct message. Comment text is only processed to match the keyword and is never stored. This lets me answer every interested follower quickly, even when a post receives dozens of comments per hour.

### instagram_business_manage_messages
> I use instagram_business_manage_messages to send a private reply to people who commented a configured keyword on my posts (or replied to my story or messaged me with that keyword). The first message has a button; only after the person taps it does the app send a follow-up message with the requested link. The app reads my conversations only to detect the button tap and keyword messages. It never sends unsolicited messages: every message answers the person's own interaction and respects Meta's messaging windows (7 days for private replies to comments, 24 hours for direct messages).

### App verification / test instructions
> InstaDM is a personal, non-commercial tool used only by me on my own Instagram professional accounts.
> 1. Open https://SEU-DOMINIO and sign in with the dashboard password: SENHA_TEMPORARIA
> 2. The "Instagram accounts" section shows my connected accounts (@CONTA_FOUNDER and @CONTA_PRODUTO).
> 3. The active automation "Review" (account @CONTA_PRODUTO) uses the keyword REVIEW.
> 4. Comment "REVIEW" on this post: LINK_DO_POST
> 5. Within about 30 seconds the comment gets a public reply and the commenter receives a direct message with a button. Tap the button (in the Instagram mobile app; quick-reply buttons are not shown on desktop) to receive the follow-up message with the link.
> 6. The "Send queue" and "Activity" sections of the dashboard show each step.

**Antes de enviar:**
- Troque o `APP_PASSWORD` por uma senha temporária no Easypanel e volte à sua depois da aprovação.
- Crie a automação "Review" com a palavra-chave `REVIEW`, na conta do produto, e deixe-a ligada.
- Preencha os @ e o link do post nas instruções.

---

## Parte 4: depois da aprovação
1. No painel da Meta, mude o app para **Live** (menu Publicar / Publish).
2. Volte o `APP_PASSWORD` para a sua senha e desligue ou exclua a automação "Review".
3. Teste com uma conta sem papel no app: a resposta no comentário, a DM e o link devem funcionar nas duas contas.

Se a Meta reprovar, ela informa o motivo por permissão. Traga o texto da reprovação para ajustarmos e reenviarmos.
