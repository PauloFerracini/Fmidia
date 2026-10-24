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

Variáveis de ambiente: `PORT` (padrão 3000), `FMIDIA_DB` (caminho do banco, padrão `data/fmidia.db`).

## Funcionalidades

| Área | O que faz |
| --- | --- |
| **Marcas** | Cada cliente é uma marca, com perfis, posts e equipe próprios. Troca rápida pela barra lateral. |
| **Perfis** | Instagram, Facebook, LinkedIn, TikTok, X, YouTube, Pinterest e Google Meu Negócio. |
| **Criar post** | Um post para vários perfis, com prévia, validação de formato e limite de caracteres por rede. |
| **Calendário** | Visão mensal colorida por status; clique em um dia para criar um post naquela data. |
| **Aprovação** | Gera um link público (`/aprovar.html?t=…`) para o cliente aprovar ou pedir ajustes sem precisar de login. Se o post já tem data, ao ser aprovado entra direto na fila. |
| **Publicação** | Um agendador roda a cada 15 s e publica os posts vencidos, registrando sucesso ou erro por perfil. |
| **Visão geral** | Seguidores, impressões, alcance, engajamento, taxa de engajamento e cliques, comparados ao período anterior. |
| **Relatório** | Relatório por período, pronto para exportar em PDF (impressão do navegador). |
| **Caixa de entrada** | Comentários, mensagens e menções de todos os perfis, com resposta e controle de lidas. |
| **Equipe** | Papéis por marca: proprietário (tudo), editor (cria e agenda) e leitor (só visualiza). |

Fluxo de status de um post: `rascunho → aguardando aprovação → aprovado/ajustes solicitados → agendado → publicado/falhou`.

## Estrutura

```
server/
  index.js        inicia o servidor, a conta demo e o agendador
  app.js          monta o Express e as rotas
  db.js           schema SQLite
  auth.js         senhas (scrypt), sessões em cookie e permissões por marca
  networks.js     redes suportadas, formatos e limites
  providers.js    integração com as redes (modo simulado)
  scheduler.js    publicação dos posts agendados
  metrics.js      geração de métricas de exemplo
  routes/         auth, brands, posts (+ aprovação pública), analytics, inbox
public/           landing (index), login (entrar), painel (app) e aprovação (aprovar)
test/             testes de API com node:test
```

## Integração real com as redes

Hoje a conexão de perfis, a publicação, as métricas e a caixa de entrada funcionam em **modo simulado**. Para colocar em produção:

1. Crie apps de desenvolvedor em cada rede (Meta for Developers para Instagram e Facebook, LinkedIn, TikTok for Developers, X API, Google/YouTube Data API, Pinterest) e passe pela revisão de permissões de cada uma.
2. Troque a rota `POST /api/brands/:id/profiles` por um fluxo OAuth e guarde os tokens de acesso (criptografados) na tabela `profiles`.
3. Implemente `publish()` por rede em `server/providers.js`.
4. Substitua `server/metrics.js` por coletas periódicas das APIs de insights e alimente a tabela `inbox` via webhooks ou polling.
5. Use armazenamento de mídia próprio (S3 ou equivalente) no lugar das URLs coladas manualmente.
