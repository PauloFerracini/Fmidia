const crypto = require('node:crypto');
const express = require('express');
const { requireBrand } = require('../auth');
const { NETWORKS, FORMATS } = require('../networks');
const { tx } = require('../db');

const EDITABLE = ['draft', 'rejected', 'approved', 'scheduled', 'failed'];

function loadPost(db, brandId, postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND brand_id = ?').get(postId, brandId);
  if (!post) return null;
  post.targets = db.prepare(
    `SELECT p.id, p.network, p.handle, t.external_id, t.error
     FROM post_targets t JOIN profiles p ON p.id = t.profile_id WHERE t.post_id = ?`
  ).all(post.id);
  return post;
}

// Valida legenda/formato contra cada rede escolhida. Retorna mensagem de erro ou null.
function validate(db, brandId, { caption, format, profileIds, scheduledAt }) {
  if (!caption?.trim()) return 'Escreva a legenda do post';
  if (!FORMATS[format]) return 'Formato inválido';
  if (!Array.isArray(profileIds) || profileIds.length === 0) return 'Selecione ao menos um perfil';
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) return 'Data de agendamento inválida';
  for (const id of profileIds) {
    const p = db.prepare('SELECT network FROM profiles WHERE id = ? AND brand_id = ?').get(Number(id), brandId);
    if (!p) return 'Perfil inválido';
    const net = NETWORKS[p.network];
    if (caption.length > net.maxCaption) return `A legenda passa do limite de ${net.maxCaption} caracteres do ${net.label}`;
    if (!net.formats.includes(format)) return `${net.label} não aceita o formato ${FORMATS[format]}`;
  }
  return null;
}

module.exports = function postRoutes(db) {
  const r = express.Router({ mergeParams: true });

  r.get('/', requireBrand(db), (req, res) => {
    const { from, to, status } = req.query;
    const where = ['brand_id = ?'];
    const args = [req.brandId];
    if (from) { where.push('COALESCE(scheduled_at, created_at) >= ?'); args.push(from); }
    if (to) { where.push('COALESCE(scheduled_at, created_at) < ?'); args.push(to); }
    if (status) { where.push('status = ?'); args.push(status); }
    const ids = db.prepare(`SELECT id FROM posts WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at) DESC`).all(...args);
    res.json(ids.map(({ id }) => loadPost(db, req.brandId, id)));
  });

  r.get('/:postId', requireBrand(db), (req, res) => {
    const post = loadPost(db, req.brandId, Number(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    res.json(post);
  });

  r.post('/', requireBrand(db, 'editor'), (req, res) => {
    const body = { format: 'feed', ...req.body };
    const error = validate(db, req.brandId, body);
    if (error) return res.status(400).json({ error });
    const id = tx(db, () => {
      const { lastInsertRowid } = db.prepare(
        "INSERT INTO posts (brand_id, author_id, caption, media_url, format, status, scheduled_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)"
      ).run(req.brandId, req.user.id, body.caption.trim(), body.mediaUrl || null, body.format,
        body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null);
      const ins = db.prepare('INSERT INTO post_targets (post_id, profile_id) VALUES (?, ?)');
      for (const pid of new Set(body.profileIds.map(Number))) ins.run(lastInsertRowid, pid);
      return Number(lastInsertRowid);
    });
    res.status(201).json(loadPost(db, req.brandId, id));
  });

  r.put('/:postId', requireBrand(db, 'editor'), (req, res) => {
    const post = loadPost(db, req.brandId, Number(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    if (!EDITABLE.includes(post.status)) return res.status(409).json({ error: 'Este post não pode mais ser editado' });
    const body = {
      caption: post.caption, mediaUrl: post.media_url, format: post.format,
      scheduledAt: post.scheduled_at, profileIds: post.targets.map((t) => t.id), ...req.body,
    };
    const error = validate(db, req.brandId, body);
    if (error) return res.status(400).json({ error });
    tx(db, () => {
      // Editar volta o post para rascunho: precisa ser reagendado/reaprovado.
      db.prepare(
        "UPDATE posts SET caption = ?, media_url = ?, format = ?, scheduled_at = ?, status = 'draft', approval_token = NULL, approval_comment = NULL WHERE id = ?"
      ).run(body.caption.trim(), body.mediaUrl || null, body.format,
        body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null, post.id);
      db.prepare('DELETE FROM post_targets WHERE post_id = ?').run(post.id);
      const ins = db.prepare('INSERT INTO post_targets (post_id, profile_id) VALUES (?, ?)');
      for (const pid of new Set(body.profileIds.map(Number))) ins.run(post.id, pid);
    });
    res.json(loadPost(db, req.brandId, post.id));
  });

  r.delete('/:postId', requireBrand(db, 'editor'), (req, res) => {
    db.prepare('DELETE FROM posts WHERE id = ? AND brand_id = ?').run(Number(req.params.postId), req.brandId);
    res.json({ ok: true });
  });

  // Envia para aprovação do cliente: gera um link público de aprovação.
  r.post('/:postId/request-approval', requireBrand(db, 'editor'), (req, res) => {
    const post = loadPost(db, req.brandId, Number(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    if (!['draft', 'rejected'].includes(post.status)) return res.status(409).json({ error: 'Só rascunhos ou posts reprovados podem ir para aprovação' });
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare("UPDATE posts SET status = 'pending_approval', approval_token = ?, approval_comment = NULL WHERE id = ?").run(token, post.id);
    res.json({ ...loadPost(db, req.brandId, post.id), approvalUrl: `/aprovar.html?t=${token}` });
  });

  // Agenda (ou publica já, com now=true).
  r.post('/:postId/schedule', requireBrand(db, 'editor'), (req, res) => {
    const post = loadPost(db, req.brandId, Number(req.params.postId));
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    if (!['draft', 'approved', 'failed'].includes(post.status)) return res.status(409).json({ error: 'Este post não pode ser agendado agora' });
    const when = req.body?.now ? new Date().toISOString() : post.scheduled_at;
    if (!when) return res.status(400).json({ error: 'Defina uma data de agendamento' });
    db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ? WHERE id = ?").run(when, post.id);
    res.json(loadPost(db, req.brandId, post.id));
  });

  r.post('/:postId/unschedule', requireBrand(db, 'editor'), (req, res) => {
    const result = db.prepare("UPDATE posts SET status = 'draft' WHERE id = ? AND brand_id = ? AND status = 'scheduled'")
      .run(Number(req.params.postId), req.brandId);
    if (!result.changes) return res.status(409).json({ error: 'Post não está agendado' });
    res.json(loadPost(db, req.brandId, Number(req.params.postId)));
  });

  return r;
};

// Rotas públicas usadas pelo cliente final pelo link de aprovação (sem login).
module.exports.approvalRoutes = function approvalRoutes(db) {
  const r = express.Router();

  const byToken = (token) => db.prepare(
    `SELECT p.id, p.brand_id, p.caption, p.media_url, p.format, p.scheduled_at, p.status, p.approval_comment, b.name AS brand_name, b.color AS brand_color
     FROM posts p JOIN brands b ON b.id = p.brand_id WHERE p.approval_token = ?`
  ).get(String(token));

  r.get('/:token', (req, res) => {
    const post = byToken(req.params.token);
    if (!post) return res.status(404).json({ error: 'Link de aprovação inválido ou expirado' });
    post.targets = db.prepare(
      'SELECT p.network, p.handle FROM post_targets t JOIN profiles p ON p.id = t.profile_id WHERE t.post_id = ?'
    ).all(post.id);
    res.json(post);
  });

  r.post('/:token', (req, res) => {
    const post = byToken(req.params.token);
    if (!post) return res.status(404).json({ error: 'Link de aprovação inválido ou expirado' });
    if (post.status !== 'pending_approval') return res.status(409).json({ error: 'Este post já foi avaliado' });
    const { decision, comment } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decisão inválida' });
    if (decision === 'reject' && !comment?.trim()) return res.status(400).json({ error: 'Conte o que precisa ser ajustado' });
    // Aprovado com data definida já entra na fila de publicação.
    const status = decision === 'reject' ? 'rejected' : post.scheduled_at ? 'scheduled' : 'approved';
    db.prepare('UPDATE posts SET status = ?, approval_comment = ? WHERE id = ?').run(status, comment?.trim() || null, post.id);
    res.json({ status });
  });

  return r;
};
