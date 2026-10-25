const express = require('express');
const { requireBrand } = require('../auth');
const { NETWORKS } = require('../networks');
const { seedMetrics } = require('../metrics');
const integrations = require('../integrations');
const { tx } = require('../db');

module.exports = function brandRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json(db.prepare(
      `SELECT b.*, m.role,
         (SELECT COUNT(*) FROM profiles p WHERE p.brand_id = b.id) AS profile_count,
         (SELECT COUNT(*) FROM posts p WHERE p.brand_id = b.id AND p.status = 'scheduled') AS scheduled_count
       FROM brands b JOIN memberships m ON m.brand_id = b.id
       WHERE m.user_id = ? ORDER BY b.name`
    ).all(req.user.id));
  });

  r.post('/', (req, res) => {
    const { name, color } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Informe o nome da marca' });
    const id = tx(db, () => {
      const { lastInsertRowid } = db.prepare('INSERT INTO brands (name, color) VALUES (?, ?)')
        .run(name.trim(), /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#6d28d9');
      db.prepare("INSERT INTO memberships (user_id, brand_id, role) VALUES (?, ?, 'owner')").run(req.user.id, lastInsertRowid);
      return Number(lastInsertRowid);
    });
    res.status(201).json(db.prepare('SELECT * FROM brands WHERE id = ?').get(id));
  });

  r.put('/:brandId', requireBrand(db, 'owner'), (req, res) => {
    const { name, color } = req.body || {};
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.brandId);
    db.prepare('UPDATE brands SET name = ?, color = ? WHERE id = ?').run(
      name?.trim() || brand.name,
      /^#[0-9a-f]{6}$/i.test(color || '') ? color : brand.color,
      req.brandId
    );
    res.json(db.prepare('SELECT * FROM brands WHERE id = ?').get(req.brandId));
  });

  r.delete('/:brandId', requireBrand(db, 'owner'), (req, res) => {
    db.prepare('DELETE FROM brands WHERE id = ?').run(req.brandId);
    res.json({ ok: true });
  });

  // Equipe
  r.get('/:brandId/members', requireBrand(db), (req, res) => {
    res.json(db.prepare(
      'SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.brand_id = ? ORDER BY u.name'
    ).all(req.brandId));
  });

  r.post('/:brandId/members', requireBrand(db, 'owner'), (req, res) => {
    const { email, role } = req.body || {};
    if (!['owner', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Papel inválido' });
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado — peça para ele criar uma conta primeiro' });
    db.prepare(
      'INSERT INTO memberships (user_id, brand_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, brand_id) DO UPDATE SET role = excluded.role'
    ).run(user.id, req.brandId, role);
    res.status(201).json({ ok: true });
  });

  r.delete('/:brandId/members/:userId', requireBrand(db, 'owner'), (req, res) => {
    const userId = Number(req.params.userId);
    const owners = db.prepare("SELECT user_id FROM memberships WHERE brand_id = ? AND role = 'owner'").all(req.brandId);
    if (owners.length === 1 && owners[0].user_id === userId) {
      return res.status(400).json({ error: 'A marca precisa de pelo menos um proprietário' });
    }
    db.prepare('DELETE FROM memberships WHERE brand_id = ? AND user_id = ?').run(req.brandId, userId);
    res.json({ ok: true });
  });

  // Perfis sociais conectados
  r.get('/:brandId/profiles', requireBrand(db), (req, res) => {
    res.json(db.prepare(`SELECT ${integrations.PUBLIC_PROFILE_COLS} FROM profiles WHERE brand_id = ? ORDER BY network, handle`).all(req.brandId));
  });

  r.post('/:brandId/profiles', requireBrand(db, 'editor'), (req, res) => {
    const { network, handle } = req.body || {};
    if (!NETWORKS[network]) return res.status(400).json({ error: 'Rede inválida' });
    if (!handle?.trim()) return res.status(400).json({ error: 'Informe o @ do perfil' });
    // Perfil de demonstração. Os reais entram pelo login OAuth (routes/oauth.js).
    const followers = 500 + Math.floor(Math.random() * 20000);
    const { lastInsertRowid } = db.prepare('INSERT INTO profiles (brand_id, network, handle, followers) VALUES (?, ?, ?, ?)')
      .run(req.brandId, network, handle.trim().replace(/^@?/, '@'), followers);
    seedMetrics(db, db.prepare('SELECT * FROM profiles WHERE id = ?').get(lastInsertRowid));
    res.status(201).json(db.prepare(`SELECT ${integrations.PUBLIC_PROFILE_COLS} FROM profiles WHERE id = ?`).get(lastInsertRowid));
  });

  r.delete('/:brandId/profiles/:profileId', requireBrand(db, 'editor'), async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ? AND brand_id = ?').get(Number(req.params.profileId), req.brandId);
    if (profile) await integrations.disconnect(db, profile);
    res.json({ ok: true });
  });

  // Sincroniza agora métricas e comentários de um perfil conectado de verdade.
  r.post('/:brandId/profiles/:profileId/sync', requireBrand(db, 'editor'), async (req, res) => {
    const profile = db.prepare("SELECT * FROM profiles WHERE id = ? AND brand_id = ? AND mode = 'live'").get(Number(req.params.profileId), req.brandId);
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });
    try {
      await integrations.syncMetrics(db, profile, 7);
      const added = await integrations.syncInbox(db, db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id));
      res.json({ ok: true, newComments: added });
    } catch (err) {
      db.prepare('UPDATE profiles SET last_error = ? WHERE id = ?').run(err.message, profile.id);
      res.status(502).json({ error: err.message });
    }
  });

  return r;
};
