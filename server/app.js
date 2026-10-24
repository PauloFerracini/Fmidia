const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { requireAuth } = require('./auth');
const { NETWORKS, FORMATS } = require('./networks');
const postRoutes = require('./routes/posts');

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/networks', (req, res) => res.json({ networks: NETWORKS, formats: FORMATS }));
  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/approval', postRoutes.approvalRoutes(db));

  const auth = requireAuth(db);
  app.use('/api/brands', auth, require('./routes/brands')(db));
  app.use('/api/brands/:brandId/posts', auth, postRoutes(db));
  app.use('/api/brands/:brandId/analytics', auth, require('./routes/analytics')(db));
  app.use('/api/brands/:brandId/inbox', auth, require('./routes/inbox')(db));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  });
  return app;
}

module.exports = { createApp };
