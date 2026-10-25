const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { requireAuth } = require('./auth');
const { config } = require('./config');
const { NETWORKS, FORMATS } = require('./networks');
const postRoutes = require('./routes/posts');
const { mediaRoutes, uploadsDir } = require('./routes/media');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const auth = requireAuth(db);
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/networks', (req, res) => res.json({
    networks: NETWORKS, formats: FORMATS,
    live: { meta: config.metaEnabled(), tiktok: config.tiktokEnabled() },
  }));
  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/approval', postRoutes.approvalRoutes(db));
  app.use('/api/oauth', require('./routes/oauth')(db, auth));

  app.use('/api/brands', auth, require('./routes/brands')(db));
  app.use('/api/brands/:brandId/posts', auth, postRoutes(db));
  app.use('/api/brands/:brandId/media', auth, mediaRoutes(db));
  app.use('/api/brands/:brandId/analytics', auth, require('./routes/analytics')(db));
  app.use('/api/brands/:brandId/inbox', auth, require('./routes/inbox')(db));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  app.use('/media', express.static(uploadsDir(), { fallthrough: false, maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo grande demais' });
    if (err.status === 404) return res.status(404).end();
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  });
  return app;
}

module.exports = { createApp };
