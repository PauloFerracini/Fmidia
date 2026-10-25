const crypto = require('node:crypto');
const { NETWORKS, checkMedia } = require('../networks');
const { encrypt, decrypt } = require('../secrets');
const { IntegrationError } = require('./http');
const meta = require('./meta');
const tiktok = require('./tiktok');

// Colunas seguras para devolver ao navegador (nunca inclui tokens).
const PUBLIC_PROFILE_COLS = 'id, brand_id, network, handle, display_name, avatar_url, followers, connected_at, mode, status, last_error, last_synced_at';

// Perfil em modo demonstração: valida e gera um ID fictício.
function simulatedPublish(profile, post) {
  const net = NETWORKS[profile.network];
  if (post.caption.length > net.maxCaption) throw new Error(`Legenda excede ${net.maxCaption} caracteres no ${net.label}`);
  if (!net.formats.includes(post.format)) throw new Error(`${net.label} não aceita o formato "${post.format}"`);
  const mediaError = checkMedia(profile.network, post.format, post.media);
  if (mediaError) throw new Error(mediaError);
  return { externalId: `${profile.network}_${crypto.randomBytes(6).toString('hex')}`, url: null };
}

function markReauth(db, profile, message) {
  db.prepare("UPDATE profiles SET status = 'reauth', last_error = ? WHERE id = ?").run(message, profile.id);
}

// Devolve um token de acesso válido, renovando o do TikTok quando está perto de expirar.
async function accessToken(db, profile) {
  if (profile.status === 'reauth') throw new IntegrationError('A conexão expirou. Reconecte o perfil.', { auth: true });
  const token = decrypt(profile.access_token);
  if (profile.network !== 'tiktok') return token;
  if (profile.token_expires_at && Date.parse(profile.token_expires_at) > Date.now() + 5 * 60_000) return token;
  const t = await tiktok.refresh(decrypt(profile.refresh_token));
  db.prepare('UPDATE profiles SET access_token = ?, refresh_token = ?, token_expires_at = ?, refresh_expires_at = ? WHERE id = ?')
    .run(encrypt(t.accessToken), encrypt(t.refreshToken), t.expiresAt, t.refreshExpiresAt, profile.id);
  return t.accessToken;
}

// Executa fn(token); se a rede recusar o token, marca o perfil para reconexão.
async function withToken(db, profile, fn) {
  try {
    return await fn(await accessToken(db, profile));
  } catch (err) {
    if (err instanceof IntegrationError && err.auth) markReauth(db, profile, err.message);
    throw err;
  }
}

const PUBLISHERS = { instagram: meta.publishInstagram, facebook: meta.publishFacebook, tiktok: tiktok.publish };

async function publish(db, profile, post) {
  if (profile.mode !== 'live') return simulatedPublish(profile, post);
  return withToken(db, profile, (token) => PUBLISHERS[profile.network](profile, post, token));
}

const METRICS = {
  instagram: (p, t, days) => meta.instagramMetrics(p, t, days),
  facebook: (p, t, days) => meta.facebookMetrics(p, t, days),
  tiktok: (p, t) => tiktok.metrics(p, t),
};

async function syncMetrics(db, profile, days = 2) {
  if (profile.mode !== 'live') return;
  const result = await withToken(db, profile, (token) => METRICS[profile.network](profile, token, days));
  const upsert = db.prepare(
    `INSERT INTO metrics (profile_id, day, followers, impressions, reach, engagement, clicks) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, day) DO UPDATE SET followers = excluded.followers, impressions = excluded.impressions,
       reach = excluded.reach, engagement = excluded.engagement, clicks = excluded.clicks`
  );
  for (const r of result.rows) upsert.run(profile.id, r.day, r.followers, r.impressions, r.reach, r.engagement, r.clicks);
  db.prepare("UPDATE profiles SET followers = ?, avatar_url = COALESCE(?, avatar_url), meta = ?, last_synced_at = ?, last_error = NULL, status = 'active' WHERE id = ?")
    .run(result.profile.followers, result.profile.avatarUrl, JSON.stringify(result.meta || JSON.parse(profile.meta || '{}')), new Date().toISOString(), profile.id);
}

const COMMENTS = { instagram: meta.instagramComments, facebook: meta.facebookComments };

async function syncInbox(db, profile) {
  if (profile.mode !== 'live' || !COMMENTS[profile.network]) return 0;
  const items = await withToken(db, profile, (token) => COMMENTS[profile.network](profile, token));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO inbox (profile_id, kind, author, body, external_id, context, created_at, reply, read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const i of items) {
    const at = new Date(i.createdAt || Date.now()).toISOString().replace('T', ' ').slice(0, 19);
    // Comentários já respondidos fora da Fmidia entram como respondidos.
    added += Number(ins.run(profile.id, i.kind, i.author, i.body, i.externalId, i.context || null, at,
      i.answered ? '(respondido diretamente na rede)' : null, i.answered ? 1 : 0).changes);
  }
  return added;
}

const REPLIERS = { instagram: meta.replyInstagram, facebook: meta.replyFacebook };

async function reply(db, profile, item, message) {
  if (profile.mode !== 'live' || !item.external_id) return; // item de demonstração
  if (!REPLIERS[profile.network]) throw new Error('Esta rede não permite responder pela Fmidia');
  await withToken(db, profile, (token) => REPLIERS[profile.network](item.external_id, message, token));
}

async function disconnect(db, profile) {
  if (profile.mode === 'live' && profile.network === 'tiktok') {
    try { await tiktok.revoke(decrypt(profile.access_token)); } catch {}
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
}

// Grava (ou atualiza, se já existir) as contas escolhidas após o login OAuth.
function saveAccounts(db, brandId, accounts) {
  const upsert = db.prepare(
    `INSERT INTO profiles (brand_id, network, handle, display_name, avatar_url, followers, mode, external_id,
       access_token, refresh_token, token_expires_at, refresh_expires_at, status, last_error, meta)
     VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, 'active', NULL, ?)
     ON CONFLICT (brand_id, network, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       handle = excluded.handle, display_name = excluded.display_name, avatar_url = excluded.avatar_url,
       followers = excluded.followers, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at, refresh_expires_at = excluded.refresh_expires_at,
       status = 'active', last_error = NULL, meta = excluded.meta
     RETURNING id`
  );
  return accounts.map((a) => upsert.get(
    brandId, a.network, a.handle, a.displayName || null, a.avatarUrl || null, a.followers || 0, a.externalId,
    encrypt(a.accessToken), encrypt(a.refreshToken), a.tokenExpiresAt || null, a.refreshExpiresAt || null,
    JSON.stringify(a.meta || {})
  ).id);
}

module.exports = { PUBLIC_PROFILE_COLS, publish, syncMetrics, syncInbox, reply, disconnect, saveAccounts };
