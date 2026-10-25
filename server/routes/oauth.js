const crypto = require('node:crypto');
const express = require('express');
const { config } = require('../config');
const { encrypt, decrypt } = require('../secrets');
const integrations = require('../integrations');
const meta = require('../integrations/meta');
const tiktok = require('../integrations/tiktok');

const STATE_TTL_MS = 15 * 60_000;
const PROVIDERS = {
  meta: { enabled: config.metaEnabled, module: meta, label: 'Meta' },
  tiktok: { enabled: config.tiktokEnabled, module: tiktok, label: 'TikTok' },
};

const back = (res, params) => res.redirect(`/app#/perfis?${new URLSearchParams(params)}`);

// Primeira sincronização (30 dias de métricas + comentários) logo após conectar, em segundo plano.
function initialSync(db, profileIds) {
  (async () => {
    for (const id of profileIds) {
      const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
      try {
        await integrations.syncMetrics(db, p, 30);
        await integrations.syncInbox(db, db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
      } catch (err) {
        db.prepare('UPDATE profiles SET last_error = ? WHERE id = ?').run(`Sincronização inicial: ${err.message}`, id);
      }
    }
  })();
}

module.exports = function oauthRoutes(db, requireAuth) {
  const r = express.Router();

  const canEdit = (userId, brandId) => {
    const m = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND brand_id = ?').get(userId, brandId);
    return m && ['owner', 'editor'].includes(m.role);
  };

  r.get('/:provider/start', requireAuth, (req, res) => {
    const provider = PROVIDERS[req.params.provider];
    const brandId = Number(req.query.brandId);
    if (!provider) return res.status(404).json({ error: 'Integração desconhecida' });
    if (!provider.enabled()) return back(res, { erro: `Integração com ${provider.label} não configurada no servidor` });
    if (!canEdit(req.user.id, brandId)) return back(res, { erro: 'Sem permissão para conectar perfis nesta marca' });
    const state = crypto.randomBytes(24).toString('hex');
    db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(new Date(Date.now() - STATE_TTL_MS).toISOString());
    db.prepare('INSERT INTO oauth_states (state, user_id, brand_id, provider, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, req.user.id, brandId, req.params.provider, new Date().toISOString());
    res.redirect(provider.module.authUrl(state));
  });

  r.get('/:provider/callback', requireAuth, async (req, res) => {
    const name = req.params.provider;
    if (!PROVIDERS[name]) return res.status(404).json({ error: 'Integração desconhecida' });
    const st = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(String(req.query.state || ''), name);
    if (st) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(st.state);
    if (!st || st.user_id !== req.user.id || Date.parse(st.created_at) < Date.now() - STATE_TTL_MS) {
      return back(res, { erro: 'Sessão de conexão expirada. Tente de novo.' });
    }
    if (req.query.error || !req.query.code) {
      return back(res, { erro: req.query.error_description || req.query.error_message || 'Conexão cancelada' });
    }
    try {
      if (name === 'tiktok') {
        const account = await tiktok.account(await tiktok.exchangeCode(String(req.query.code)));
        const ids = integrations.saveAccounts(db, st.brand_id, [account]);
        initialSync(db, ids);
        return back(res, { ok: `TikTok ${account.handle} conectado` });
      }
      const { accounts } = await meta.exchangeCode(String(req.query.code));
      if (!accounts.length) {
        return back(res, { erro: 'Nenhuma Página do Facebook encontrada. O Instagram precisa ser conta profissional vinculada a uma Página.' });
      }
      const id = crypto.randomBytes(16).toString('hex');
      const sealed = accounts.map((a) => ({ ...a, accessToken: encrypt(a.accessToken) }));
      db.prepare('INSERT INTO oauth_pending (id, user_id, brand_id, accounts, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, req.user.id, st.brand_id, JSON.stringify(sealed), new Date().toISOString());
      res.redirect(`/app#/conectar/${id}`);
    } catch (err) {
      console.error(`[oauth ${name}]`, err);
      back(res, { erro: `Não foi possível conectar: ${err.message}` });
    }
  });

  const loadPending = (req) => {
    const p = db.prepare('SELECT * FROM oauth_pending WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
    if (!p || Date.parse(p.created_at) < Date.now() - 30 * 60_000) return null;
    return { ...p, accounts: JSON.parse(p.accounts) };
  };

  // Contas encontradas no login da Meta, para o usuário escolher quais conectar.
  r.get('/pending/:id', requireAuth, (req, res) => {
    const p = loadPending(req);
    if (!p) return res.status(404).json({ error: 'Seleção expirada. Conecte novamente.' });
    const existing = new Set(db.prepare("SELECT network || ':' || external_id AS k FROM profiles WHERE brand_id = ? AND external_id IS NOT NULL")
      .all(p.brand_id).map((x) => x.k));
    res.json({
      brandId: p.brand_id,
      accounts: p.accounts.map((a, index) => ({
        index, network: a.network, handle: a.handle, displayName: a.displayName, followers: a.followers,
        avatarUrl: a.avatarUrl, pageName: a.meta?.pageName || null, connected: existing.has(`${a.network}:${a.externalId}`),
      })),
    });
  });

  r.post('/pending/:id', requireAuth, (req, res) => {
    const p = loadPending(req);
    if (!p) return res.status(404).json({ error: 'Seleção expirada. Conecte novamente.' });
    if (!canEdit(req.user.id, p.brand_id)) return res.status(403).json({ error: 'Permissão insuficiente' });
    const chosen = [...new Set((req.body?.indexes || []).map(Number))].map((i) => p.accounts[i]).filter(Boolean);
    if (!chosen.length) return res.status(400).json({ error: 'Selecione ao menos uma conta' });
    const ids = integrations.saveAccounts(db, p.brand_id, chosen.map((a) => ({ ...a, accessToken: decrypt(a.accessToken) })));
    db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(p.id);
    initialSync(db, ids);
    res.json({ brandId: p.brand_id, connected: ids.length });
  });

  // URL de "exclusão de dados" cadastrada no app da Meta.
  r.post('/meta/data-deletion', express.urlencoded({ extended: false }), (req, res) => {
    const payload = config.metaEnabled() && meta.parseSignedRequest(req.body?.signed_request);
    if (!payload?.user_id) return res.status(400).json({ error: 'signed_request inválido' });
    const removed = db.prepare("DELETE FROM profiles WHERE mode = 'live' AND network IN ('facebook','instagram') AND json_extract(meta, '$.metaUserId') = ?")
      .run(String(payload.user_id)).changes;
    const code = crypto.randomBytes(8).toString('hex');
    console.log(`[meta] exclusão de dados ${code}: ${removed} perfil(is) removido(s)`);
    res.json({ url: `${config.publicUrl()}/privacidade?exclusao=${code}`, confirmation_code: code });
  });

  return r;
};
