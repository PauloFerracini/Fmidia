// Configuração lida do ambiente a cada chamada, para facilitar testes e recarga.
const env = (k, d) => process.env[k] || d;

const config = {
  publicUrl: () => env('PUBLIC_URL', `http://localhost:${env('PORT', 3000)}`).replace(/\/$/, ''),
  meta: () => ({
    appId: env('META_APP_ID'),
    appSecret: env('META_APP_SECRET'),
    graphVersion: env('META_GRAPH_VERSION', 'v23.0'),
    configId: env('META_CONFIG_ID'), // opcional: "Facebook Login for Business"
  }),
  tiktok: () => ({
    clientKey: env('TIKTOK_CLIENT_KEY'),
    clientSecret: env('TIKTOK_CLIENT_SECRET'),
    privacy: env('TIKTOK_PRIVACY', 'PUBLIC_TO_EVERYONE'),
  }),
  pollMs: () => Number(env('FMIDIA_POLL_MS', 3000)),
  publishTimeoutMs: () => Number(env('FMIDIA_PUBLISH_TIMEOUT_MS', 5 * 60_000)),
};

config.metaEnabled = () => Boolean(config.meta().appId && config.meta().appSecret);
config.tiktokEnabled = () => Boolean(config.tiktok().clientKey && config.tiktok().clientSecret);

module.exports = { config };
