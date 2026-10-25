# Fmidia

Plataforma de gestão de redes sociais para social media, agências e pequenas empresas. Ela cobre a rotina de ferramentas como o mLabs: agendamento em várias redes, calendário editorial, aprovação pelo cliente, analytics, relatórios, caixa de entrada unificada e gestão de equipe por marca.

## Rodando

Requer **Node.js 22.13+** (usa o SQLite nativo `node:sqlite`, sem dependências nativas).

```bash
npm install
npm start          # http://localhost:3000
npm test           # testes da API
```

Na primeira execução é criada uma conta de demonstração com três marcas, perfis, posts e métricas de exemplo:
**demo@fmidia.com / demo123** (desative com `FMIDIA_NO_DEMO=1`).

Configuração por variáveis de ambiente ou arquivo `.env` (veja `.env.example`).

## Funcionalidades

| Área | O que faz |
| --- | --- |
| **Marcas** | Cada cliente é uma marca, com perfis, posts e equipe próprios. Troca rápida pela barra lateral. |
| **Perfis** | Instagram, Facebook e TikTok com integração real (login OAuth); LinkedIn, X, YouTube, Pinterest e Google Meu Negócio em modo demonstração. |
| **Criar post** | Um post para vários perfis, com prévia, upload de imagens e vídeos, carrossel e validação de formato, mídia e limite de caracteres por rede. |
| **Calendário** | Visão mensal colorida por status; clique em um dia para criar um post naquela data. |
| **Aprovação** | Gera um link público (`/aprovar.html?t=…`) para o cliente aprovar ou pedir ajustes sem precisar de login. Se o post já tem data, ao ser aprovado entra direto na fila. |
| **Publicação** | Um agendador roda a cada 15 s e publica os posts vencidos, registrando sucesso ou erro por perfil. |
| **Visão geral** | Seguidores, impressões, alcance, engajamento, taxa de engajamento e cliques, comparados ao período anterior. |
| **Relatório** | Relatório por período, pronto para exportar em PDF (impressão do navegador). |
| **Caixa de entrada** | Comentários, mensagens e menções de todos os perfis, com resposta e controle de lidas. |
| **Equipe** | Papéis por marca: proprietário (tudo), editor (cria e agenda) e leitor (só visualiza). |

Fluxo de status de um post: `rascunho → aguardando aprovação → aprovado/ajustes solicitados → agendado → publicando → publicado/falhou`.

## Estrutura

```
server/
  index.js          inicia o servidor, a conta demo e o agendador
  app.js            monta o Express e as rotas
  db.js             schema SQLite e migrações
  auth.js           senhas (scrypt), sessões em cookie e permissões por marca
  config.js         variáveis de ambiente
  secrets.js        cifragem dos tokens das redes (AES-256-GCM)
  networks.js       redes, formatos e regras de mídia
  scheduler.js      publicação dos posts agendados e sincronização periódica
  integrations/
    index.js        escolhe entre integração real e modo demonstração; renova tokens
    meta.js         Facebook e Instagram (Graph API)
    tiktok.js       TikTok (Login Kit + Content Posting API)
  routes/           auth, brands, posts (+ aprovação pública), oauth, media, analytics, inbox
public/             landing, login, painel, aprovação, privacidade e termos
test/               testes da API e das integrações (APIs externas simuladas)
```

## Integração real: Instagram, Facebook e TikTok

Perfis conectados pelo login da rede publicam de verdade; os perfis adicionados manualmente continuam em **modo demonstração**. As demais redes (LinkedIn, X, YouTube, Pinterest, Google) seguem só em demonstração.

| | Instagram | Facebook (Página) | TikTok |
| --- | --- | --- | --- |
| Conectar conta | ✅ via login da Meta | ✅ via login da Meta | ✅ |
| Feed (imagem) | ✅ | ✅ (ou só texto) | ✅ post de foto |
| Carrossel | ✅ 2 a 10 imagens/vídeos | ✅ várias fotos num post | ✅ 2 a 35 fotos |
| Reels / vídeo | ✅ | ✅ (vídeo da Página) | ✅ |
| Stories | ✅ | — | — |
| Métricas | ✅ diárias, 30 dias de histórico | ✅ diárias | ⚠ desde a conexão (ver abaixo) |
| Comentários na caixa de entrada | ✅ com resposta | ✅ com resposta | — (a API não oferece) |

### 1. Pré-requisitos

- **Servidor público com HTTPS.** As redes redirecionam o login de volta para `PUBLIC_URL` e baixam as mídias por link. Para testar na sua máquina, use um túnel (por exemplo `ngrok http 3000`) e coloque a URL dele em `PUBLIC_URL`.
- Copie `.env.example` para `.env`, defina `PUBLIC_URL` e gere `FMIDIA_SECRET` com `openssl rand -hex 32`.
- Publique a política de privacidade e os termos (`/privacidade` e `/termos`) depois de preencher os dados da empresa; os dois apps exigem esses links.

### 2. App da Meta (Instagram + Facebook)

1. Em [developers.facebook.com](https://developers.facebook.com/apps), crie um app do tipo **Empresa** e adicione o produto **Facebook Login for Business** (ou Facebook Login).
2. Em *Configurações do login*, cadastre a URL de redirecionamento: `https://SEU_DOMINIO/api/oauth/meta/callback`.
3. Em *Configurações > Básico*: preencha a URL da política de privacidade (`https://SEU_DOMINIO/privacidade`), dos termos (`/termos`) e a **URL de exclusão de dados** `https://SEU_DOMINIO/api/oauth/meta/data-deletion`.
4. Copie o *ID do app* e a *Chave secreta* para `META_APP_ID` e `META_APP_SECRET`.
5. Permissões usadas: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights`, `business_management`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`.
6. **Modo desenvolvimento:** funciona na hora, mas só com contas de pessoas com papel no app (admin, desenvolvedor ou testador). **Para clientes reais**, é preciso fazer a *Verificação da empresa* e passar pelo *App Review* de cada permissão acima, com vídeo mostrando o uso. Isso costuma levar de alguns dias a algumas semanas.

Requisito do lado do cliente: o Instagram precisa ser **conta profissional** (Empresa ou Criador de conteúdo) **vinculada a uma Página do Facebook**, e quem faz o login precisa ter acesso a essa Página.

### 3. App do TikTok

1. Em [developers.tiktok.com](https://developers.tiktok.com/apps), crie um app e adicione os produtos **Login Kit** e **Content Posting API** (com *Direct Post* ativado).
2. Cadastre a URL de redirecionamento `https://SEU_DOMINIO/api/oauth/tiktok/callback`, os links de termos e privacidade e os escopos `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list` e `video.publish`.
3. Em *URL properties*, **verifique o domínio** de `PUBLIC_URL`: o TikTok só baixa mídia (`PULL_FROM_URL`) de domínios verificados.
4. Copie *Client key* e *Client secret* para `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`.
5. **Antes da auditoria do TikTok, todo post sai como privado** (`SELF_ONLY`), visível só para o dono da conta; a Fmidia mostra isso no editor. Para publicar de forma pública, envie o app para auditoria.

#### Tela de publicação do TikTok (requisitos da auditoria)

Ao selecionar uma conta do TikTok, o editor mostra o painel **Configurações do TikTok**, que segue as diretrizes de UX do *Direct Post*:

- **Conta:** nome e @ de quem vai publicar, obtidos na hora pelo `creator_info` da conta.
- **Quem pode ver:** só as opções que a conta permite, **sem valor pré-selecionado**.
- **Interações** (comentários, duetos e costura): começam **desmarcadas**; ficam desativadas se a conta as bloqueou. Duetos e costura só aparecem para vídeo.
- **Divulgação de conteúdo comercial:** desligada por padrão. Ao ligar, é preciso escolher *Sua marca* (rótulo "Conteúdo promocional") e/ou *Conteúdo de marca* (rótulo "Parceria paga"). Conteúdo de marca não pode ser privado: a opção "Somente eu" fica indisponível e vice-versa.
- **Declaração:** link para a Confirmação de Uso de Música (e para a Política de Conteúdo de Marca, quando aplicável).
- **Duração do vídeo:** conferida contra o limite da conta antes de salvar.
- **Bloqueios da conta** (limite diário de posts, conta impedida): exibidos no painel e impedem salvar.
- **Aviso** de que o TikTok pode levar alguns minutos para processar o conteúdo.

As escolhas são salvas por perfil no post e conferidas de novo na hora da publicação. Se a conta deixar de permitir a privacidade escolhida, o post falha com uma mensagem pedindo para editar, sem enviar nada ao TikTok.

Para o vídeo da auditoria, grave o fluxo completo: conectar a conta, criar um post com esse painel, publicar e mostrar o resultado no TikTok.

### Como funciona

- **Login:** `/api/oauth/{meta|tiktok}/start` → rede → `/callback`. Na Meta, a Fmidia lista as Páginas e os Instagrams encontrados e você escolhe quais conectar na marca.
- **Tokens:** guardados cifrados no banco e nunca enviados ao navegador. Os tokens de Página da Meta não expiram; o do TikTok dura 24 h e é renovado automaticamente. Se a rede recusar o token (senha trocada, acesso removido), o perfil fica como **Reconectar** e os posts param de ir para ele.
- **Publicação:** o agendador roda a cada 15 s. Vídeos podem levar alguns minutos, porque a rede precisa processar a mídia antes; a Fmidia acompanha o processamento. Se uma rede falhar, o post fica como *Falhou* com o motivo por perfil, e reagendar publica só nos perfis que faltaram.
- **Mídia:** envie arquivos pelo editor (ficam em `data/uploads`, servidos em `PUBLIC_URL/media/...`) ou cole links públicos. Instagram aceita imagens apenas em **JPEG**.
- **Sincronização:** ao conectar, a Fmidia busca 30 dias de métricas e os comentários recentes. Depois, comentários a cada 10 minutos e métricas a cada 6 horas; o botão **Sincronizar** força na hora.
- **Métricas do TikTok:** a API não fornece insights diários de contas comuns. A Fmidia registra seguidores e a variação diária das visualizações e interações dos vídeos recentes, então o histórico começa no dia da conexão.

### Limitações conhecidas

- Mensagens diretas (Instagram Direct e Messenger) não estão incluídas: exigem webhooks e permissões extras (`instagram_manage_messages`, `pages_messaging`).
- No Facebook, Reels e Stories de Página usam fluxos de upload próprios; hoje vídeos vão como vídeo da Página.
- A Meta renomeia métricas de Página com frequência; a Fmidia tenta as atuais e cai para as antigas, mas vale conferir os números após cada mudança de versão da Graph API (`META_GRAPH_VERSION`).
