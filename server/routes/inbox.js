const express = require('express');
const { requireBrand } = require('../auth');
const integrations = require('../integrations');

module.exports = function inboxRoutes(db) {
  const r = express.Router({ mergeParams: true });

  r.get('/', requireBrand(db), (req, res) => {
    const filter = req.query.status === 'open' ? 'AND i.reply IS NULL' : req.query.status === 'answered' ? 'AND i.reply IS NOT NULL' : '';
    res.json(db.prepare(
      `SELECT i.*, p.network, p.handle FROM inbox i JOIN profiles p ON p.id = i.profile_id
       WHERE p.brand_id = ? ${filter} ORDER BY i.created_at DESC LIMIT 200`
    ).all(req.brandId));
  });

  const ownItem = (brandId, id) => db.prepare(
    'SELECT i.* FROM inbox i JOIN profiles p ON p.id = i.profile_id WHERE i.id = ? AND p.brand_id = ?'
  ).get(id, brandId);

  r.post('/:itemId/reply', requireBrand(db, 'editor'), async (req, res) => {
    const item = ownItem(req.brandId, Number(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!req.body?.reply?.trim()) return res.status(400).json({ error: 'Escreva a resposta' });
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(item.profile_id);
    try {
      await integrations.reply(db, profile, item, req.body.reply.trim());
    } catch (err) {
      return res.status(502).json({ error: `A rede recusou a resposta: ${err.message}` });
    }
    db.prepare("UPDATE inbox SET reply = ?, replied_at = datetime('now'), read = 1 WHERE id = ?").run(req.body.reply.trim(), item.id);
    res.json(ownItem(req.brandId, item.id));
  });

  r.post('/:itemId/read', requireBrand(db), (req, res) => {
    const item = ownItem(req.brandId, Number(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Mensagem não encontrada' });
    db.prepare('UPDATE inbox SET read = 1 WHERE id = ?').run(item.id);
    res.json({ ok: true });
  });

  return r;
};
