# InstaDM

Microapp pessoal e **não comercial** de automação de palavra-chave no Instagram (comentários, respostas de story e DM), para as suas próprias contas: por exemplo, a conta founder e a conta do produto. Usa um app próprio na Meta (API do Instagram com login do Instagram), com dados no Supabase. O painel é em português; as páginas legais (`/privacy`, `/terms`, `/data-deletion`) ficam em inglês, para a Meta.

**Fluxo do comentário:**
1. A pessoa comenta a palavra-chave.
2. O app responde no comentário, com uma resposta sorteada entre no mínimo 5 cadastradas e sem repetir as últimas.
3. Envia na DM a 1ª mensagem com o botão (CTA) que você definiu.
4. Quando a pessoa toca no botão, envia a mensagem com o link.

Os textos dos passos 2 a 4 são definidos e editados em cada automação. Respostas de story e DMs com a palavra-chave seguem os passos 3 e 4.

Esse é o padrão anti-spam: o link só é enviado depois que a pessoa interage, o que abre a janela de 24h do Instagram.

## Como funciona

- Você conecta **uma ou mais contas** pelo **login do Instagram** do seu próprio app na Meta, com o botão **Conectar conta**. A tela de login sempre aparece, para você escolher qual conta conectar. Cada token (válido por 60 dias) fica no Supabase e é **renovado sozinho** quando faltam menos de 15 dias.
- Cada automação pertence a uma conta. Fila, limite por hora e histórico são separados por conta.
- **Conta desconectada:** as automações dela pausam e os itens da fila esperam a reconexão, até o prazo da Meta.
- **Detecção em dois caminhos, que alimentam a mesma fila** (sem duplicar envios):
  - **Webhook:** a Meta avisa na hora sobre comentários e mensagens, em qualquer post. Cada conta é inscrita automaticamente, e o painel mostra o último evento recebido. A documentação da Meta diz que os eventos de **comentário** por webhook exigem Advanced Access, mas em 10/10/2026 eles chegaram sem a revisão, com o app publicado: um comentário num post de 27/06 foi respondido.
  - **Polling (rede de segurança):** a cada 20s, o app verifica os 50 posts mais recentes (só lê comentários dos posts cuja contagem mudou) e as conversas. Cobre o que o webhook não entregar, inclusive quando o app esteve fora do ar.

### Fila de envio (nenhum comentário fica sem resposta)

Todo comentário, resposta de story ou DM que bate com uma automação entra numa **fila no banco**. O item só sai de lá enviado ou com o prazo da Meta vencido.

- **Erro temporário** (instabilidade, limite da Meta): o envio é repetido em 30s, 2 min, 10 min, 30 min e depois de hora em hora, até o prazo.
- **Prazos da Meta:** 7 dias após o comentário (resposta privada) e 24h após a mensagem ou o clique (DM).
- **Limite por hora** (`MAX_SENDS_PER_HOUR`, padrão 120 por conta): vale só para a 1ª mensagem. O que passar disso **espera na fila**, não é descartado. A mensagem com o link nunca espera por esse limite, porque foi a pessoa que pediu.
- **App fora do ar** (deploy, reinício): ao voltar, ele pagina os comentários e conversas desde a última verificação e coloca na fila o que chegou nesse meio-tempo.
- **Sem duplicidade:** cada comentário ou mensagem gera um item único, e o envio é reservado com trava no banco. Mesmo duas instâncias rodando juntas não mandam mensagem em dobro.
- **Falhas definitivas** (ex.: a pessoa bloqueou mensagens): aparecem em vermelho no painel, com o botão **Tentar de novo**.
- **Resposta no comentário e DM são independentes:** se uma falhar temporariamente, a outra segue, e a que falhou é repetida até dar certo.
- **Mesma pessoa repetindo a palavra-chave:** todo comentário recebe resposta no comentário, mas a DM só vai uma vez a cada 24h por pessoa e automação (`COOLDOWN_HOURS`). Isso aparece como "DM não repetida".
- **Automação desativada:** os itens que já estavam na fila continuam sendo enviados.

Outras proteções anti-spam: pausa aleatória de 1,5–5s antes de cada envio, e só são respondidos eventos posteriores à ativação da automação.

## App na Meta (uma vez só)

1. Em [developers.facebook.com/apps](https://developers.facebook.com/apps): **Create app**.
2. Em **Use cases**, filtre por "Business messaging" e marque **Manage messaging & content on Instagram**. Em **Business**, pode seguir sem portfólio.
3. No painel do app: **Use cases → Instagram → Customize / API setup with Instagram login**.
   - Copie o **Instagram app ID** e o **Instagram app secret**: eles viram `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`.
   - Em **Set up Instagram business login → Business login settings → OAuth redirect URIs**, cadastre `https://SEU-DOMINIO/auth/callback`. O painel do InstaDM mostra a URL exata.
4. Em **App roles → Roles → Add people → Instagram Tester**, adicione **as duas contas** (founder e produto) e aceite o convite em cada uma: instagram.com → Configurações → Apps e sites → Convites de testador. Enquanto o app não estiver em modo Live, só contas com papel no app conseguem conectar.
5. Em **Use cases → Instagram API → Permissions and features**, confirme que estas três estão adicionadas: `instagram_business_basic`, `instagram_business_manage_comments` e `instagram_business_manage_messages`. Atenção: `instagram_manage_comments` é a versão do login do Facebook e não serve aqui.
6. **Webhook:** em **API setup with Instagram login → 3. Configure webhooks**, cole a **URL** e o **token de verificação** que aparecem no painel (seção Contas do Instagram), clique em **Verify and save** e assine os campos `comments` e `messages`. Copie o **App secret** de **App settings → Basic** para `META_APP_SECRET` no Easypanel.
7. Em **App settings → Basic**, preencha o App Domains (só o domínio) e as URLs de privacidade, termos e exclusão de dados (`/privacy`, `/terms`, `/data-deletion`). Depois, em **Publish**, publique o app.
   - **Não precisa de App Review** para uso nas suas próprias contas. Testado em 10/10/2026: com o app publicado, comentários de contas sem nenhum papel no app dispararam o fluxo completo. Em modo Development (não publicado), a API esconde comentários e mensagens de quem não tem papel no app.
   - O roteiro em [docs/APP_REVIEW.md](docs/APP_REVIEW.md) fica como plano B, caso a Meta passe a exigir a revisão.
8. Em **cada uma das contas**, no app do Instagram: Configurações → Mensagens e respostas ao story → Controles de mensagens → Ferramentas conectadas → ative **Permitir acesso às mensagens**.

## Supabase

1. Crie um projeto novo no Supabase.
2. Clique em **Connect** → **Session pooler** e copie a string de conexão. Use essa, porque funciona em IPv4. A "Direct connection" é só IPv6 e pode não funcionar no Easypanel.
3. Troque `[YOUR-PASSWORD]` pela senha do banco definida na criação do projeto.

As tabelas são criadas automaticamente na primeira execução, com RLS ligado e sem políticas. Assim, a API pública do Supabase (anon key) não acessa nada, só o app.

## Deploy no Easypanel

1. Suba esta pasta para um repositório Git privado.
2. No Easypanel: **+ Service → App** → origem Git → build **Dockerfile**.
3. **Environment**:
   ```
   APP_PASSWORD=uma_senha_forte
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   DATABASE_URL=postgresql://postgres.xxxx:SENHA@aws-0-....pooler.supabase.com:5432/postgres
   APP_URL=https://instadm.seudominio.com
   META_APP_SECRET=...
   LEGAL_OWNER=Seu nome
   LEGAL_EMAIL=seu@email.com
   ```
4. **Domains**: aponte um domínio com HTTPS para a porta `3000`. Não precisa de volume, os dados ficam no Supabase.
5. Abra o domínio nos dois PCs, entre com a senha e clique em **Conectar conta** uma vez para cada conta (Business ou Criador).

## Rodar localmente

```bash
cp .env.example .env   # preencha as variáveis
npm install
npm start              # http://localhost:3000
```

A versão local pode usar o mesmo Supabase do Easypanel: a fila evita envios duplicados.

## Limitações do Instagram

- Resposta privada a comentário: **uma por comentário**, até **7 dias** após o comentário.
- Botões do tipo *quick reply* **não aparecem no Instagram desktop**. Se o Instagram recusar o botão, o app manda a mensagem só em texto, pedindo para a pessoa responder com o texto do botão. O clique também é detectado se a pessoa digitar exatamente esse texto.
- Palavra-chave no modo "contém" exige a palavra inteira: `ebook` casa com "quero o EBOOK!" e com "ébook", mas não com "ebooks". Acentos e maiúsculas são ignorados.
- Respostas a comentários (threads) são verificadas nos comentários varridos. Uma resposta nova a um comentário muito antigo pode não ser vista.
- O polling verifica os 50 posts mais recentes (`MEDIA_LIMIT`), mais os posts escolhidos nas automações. Posts mais antigos dependem do webhook.
