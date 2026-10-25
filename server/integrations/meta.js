const crypto = require('node:crypto');
const { config } = require('../config');
const { request, poll, IntegrationError } = require('./http');
const { isVideo } = require('../networks');

// Permissões pedidas no login. Todas exigem App Review da Meta para uso com contas de terceiros.
const SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content',
  'pages_manage_engagement', 'read_insights', 'business_management',
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights',
];

const redirectUri = () => `${config.publicUrl()}/api/oauth/meta/callback`;
const base = () => `https://graph.facebook.com/${config.meta().graphVersion}`;

async function graph(path, { method = 'GET', token, query, form } = {}) {
  const url = path.startsWith('http') ? path : `${base()}${path}`;
  const { status, data } = method === 'GET'
    ? await request(url, { query: { ...query, access_token: token } })
    : await request(url, { method, form: { ...form, access_token: token } });
  if (data.error) {
    const e = data.error;
    throw new IntegrationError(e.error_user_msg || e.message || 'Erro na API da Meta', {
      status, code: e.code, details: e,
      auth: e.code === 190 || e.code === 102 || (e.type === 'OAuthException' && [463, 467, 460].includes(e.error_subcode)),
    });
  }
  if (status >= 400) throw new IntegrationError(`API da Meta respondeu ${status}`, { status });
  return data;
}

function authUrl(state) {
  const { appId, graphVersion, configId } = config.meta();
  const u = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  if (configId) u.searchParams.set('config_id', configId);
  else u.searchParams.set('scope', SCOPES.join(','));
  return u.toString();
}

// Troca o code do login por um token de longa duração e lista as Páginas e contas do Instagram.
async function exchangeCode(code) {
  const { appId, appSecret } = config.meta();
  const short = await graph('/oauth/access_token', { query: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(), code } });
  const long = await graph('/oauth/access_token', {
    query: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token },
  });
  const userToken = long.access_token;
  const me = await graph('/me', { token: userToken, query: { fields: 'id,name' } });

  const pages = [];
  let next = `${base()}/me/accounts`;
  let query = {
    token: userToken,
    query: { limit: 100, fields: 'id,name,username,access_token,followers_count,fan_count,picture{url},instagram_business_account{id,username,name,profile_picture_url,followers_count}' },
  };
  while (next && pages.length < 500) {
    const page = await graph(next, query);
    pages.push(...(page.data || []));
    next = page.paging?.next;
    query = {}; // a URL "next" já traz token e parâmetros
  }

  const accounts = [];
  for (const p of pages) {
    // Tokens de Página obtidos a partir de um token de usuário de longa duração não expiram.
    accounts.push({
      network: 'facebook', externalId: p.id, handle: p.username ? `@${p.username}` : p.name, displayName: p.name,
      followers: p.followers_count ?? p.fan_count ?? 0, avatarUrl: p.picture?.data?.url || null,
      accessToken: p.access_token, meta: { metaUserId: me.id },
    });
    const ig = p.instagram_business_account;
    if (ig) {
      accounts.push({
        network: 'instagram', externalId: ig.id, handle: `@${ig.username}`, displayName: ig.name || ig.username,
        followers: ig.followers_count ?? 0, avatarUrl: ig.profile_picture_url || null,
        accessToken: p.access_token, meta: { metaUserId: me.id, pageId: p.id, pageName: p.name },
      });
    }
  }
  return { metaUserId: me.id, accounts };
}

/* ---------- Publicação ---------- */

async function waitContainer(id, token) {
  return poll(async () => {
    const c = await graph(`/${id}`, { token, query: { fields: 'status_code,status' } });
    if (c.status_code === 'FINISHED') return true;
    if (['ERROR', 'EXPIRED'].includes(c.status_code)) {
      throw new IntegrationError(`O Instagram recusou a mídia: ${c.status || c.status_code}`);
    }
    return undefined;
  }, 'o Instagram processar a mídia');
}

async function publishInstagram(profile, post, token) {
  const ig = profile.external_id;
  const create = async (params) => {
    const { id } = await graph(`/${ig}/media`, { method: 'POST', token, form: params });
    await waitContainer(id, token);
    return id;
  };
  const one = (url) => (isVideo(url) ? { media_type: 'VIDEO', video_url: url } : { image_url: url });
  let creationId;
  if (post.format === 'carousel') {
    const children = [];
    for (const url of post.media) children.push(await create({ ...one(url), is_carousel_item: true }));
    creationId = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
  } else if (post.format === 'stories') {
    const url = post.media[0];
    creationId = await create(isVideo(url) ? { media_type: 'STORIES', video_url: url } : { media_type: 'STORIES', image_url: url });
  } else if (post.format === 'reels' || isVideo(post.media[0])) {
    creationId = await create({ media_type: 'REELS', video_url: post.media[0], caption: post.caption, share_to_feed: true });
  } else {
    creationId = await create({ image_url: post.media[0], caption: post.caption });
  }
  const { id } = await graph(`/${ig}/media_publish`, { method: 'POST', token, form: { creation_id: creationId } });
  let url = null;
  try { url = (await graph(`/${id}`, { token, query: { fields: 'permalink' } })).permalink || null; } catch {}
  return { externalId: id, url };
}

async function publishFacebook(profile, post, token) {
  const page = profile.external_id;
  const media = post.media;
  if (media.length === 0) {
    const { id } = await graph(`/${page}/feed`, { method: 'POST', token, form: { message: post.caption } });
    return { externalId: id, url: `https://www.facebook.com/${id}` };
  }
  if (isVideo(media[0])) {
    const { id } = await graph(`/${page}/videos`, { method: 'POST', token, form: { file_url: media[0], description: post.caption } });
    return { externalId: id, url: `https://www.facebook.com/${page}/videos/${id}` };
  }
  if (media.length === 1) {
    const r = await graph(`/${page}/photos`, { method: 'POST', token, form: { url: media[0], message: post.caption } });
    return { externalId: r.post_id || r.id, url: `https://www.facebook.com/${r.post_id || r.id}` };
  }
  // Várias fotos: sobe cada uma sem publicar e cria um único post com todas anexadas.
  const attached = {};
  for (const [i, url] of media.entries()) {
    const { id } = await graph(`/${page}/photos`, { method: 'POST', token, form: { url, published: false } });
    attached[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  }
  const { id } = await graph(`/${page}/feed`, { method: 'POST', token, form: { message: post.caption, ...attached } });
  return { externalId: id, url: `https://www.facebook.com/${id}` };
}

/* ---------- Métricas ---------- */

const dayStr = (d) => d.toISOString().slice(0, 10);
const lastDays = (days) => Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 864e5));

// Retorna [{ day, followers, impressions, reach, engagement, clicks }] dos últimos `days` dias.
async function instagramMetrics(profile, token, days) {
  const ig = profile.external_id;
  const info = await graph(`/${ig}`, { token, query: { fields: 'followers_count,username,profile_picture_url' } });

  // Novos seguidores por dia (só disponível para os últimos 30 dias) para reconstruir o histórico.
  const gained = {};
  try {
    const since = Math.floor((Date.now() - Math.min(days, 30) * 864e5) / 1000);
    const r = await graph(`/${ig}/insights`, { token, query: { metric: 'follower_count', period: 'day', since, until: Math.floor(Date.now() / 1000) } });
    for (const v of r.data?.[0]?.values || []) gained[v.end_time.slice(0, 10)] = v.value || 0;
  } catch {}

  const rows = [];
  for (const d of lastDays(days)) {
    const start = new Date(`${dayStr(d)}T00:00:00Z`);
    const query = { period: 'day', metric_type: 'total_value', since: start / 1000, until: Math.min(Date.now(), +start + 864e5) / 1000 | 0 };
    const values = {};
    for (const metrics of ['reach,views,total_interactions,website_clicks', 'reach,views,total_interactions']) {
      try {
        const r = await graph(`/${ig}/insights`, { token, query: { ...query, metric: metrics } });
        for (const m of r.data || []) values[m.name] = m.total_value?.value ?? 0;
        break;
      } catch (err) { if (err.auth) throw err; }
    }
    rows.push({ day: dayStr(d), impressions: values.views || 0, reach: values.reach || 0, engagement: values.total_interactions || 0, clicks: values.website_clicks || 0 });
  }
  // Sem a contagem (conta pequena ou permissão faltando), mantém o último valor conhecido.
  let followers = info.followers_count ?? profile.followers ?? 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    rows[i].followers = followers;
    followers -= gained[rows[i].day] || 0;
  }
  return { rows, profile: { followers: info.followers_count ?? profile.followers ?? 0, avatarUrl: info.profile_picture_url || null } };
}

async function facebookMetrics(profile, token, days) {
  const page = profile.external_id;
  const info = await graph(`/${page}`, { token, query: { fields: 'followers_count,fan_count,picture{url}' } });
  const since = Math.floor((Date.now() - days * 864e5) / 1000);
  const until = Math.floor(Date.now() / 1000);
  // A Meta vem renomeando métricas de Página; tentamos as atuais e caímos para as antigas.
  const CANDIDATES = {
    impressions: ['page_media_view', 'page_impressions'],
    reach: ['page_total_media_view_unique', 'page_impressions_unique'],
    engagement: ['page_post_engagements'],
    clicks: ['page_total_actions'],
    followers: ['page_follows', 'page_fans'],
  };
  const series = {};
  for (const [field, names] of Object.entries(CANDIDATES)) {
    for (const metric of names) {
      try {
        const r = await graph(`/${page}/insights`, { token, query: { metric, period: 'day', since, until } });
        const values = r.data?.[0]?.values;
        if (!values) continue;
        // end_time marca o fim do dia (fuso do Pacífico); o dia medido é o anterior.
        series[field] = Object.fromEntries(values.map((v) => [dayStr(new Date(Date.parse(v.end_time) - 864e5)), v.value || 0]));
        break;
      } catch (err) { if (err.auth) throw err; }
    }
  }
  const current = info.followers_count ?? info.fan_count ?? profile.followers ?? 0;
  const rows = lastDays(days).map((d) => {
    const day = dayStr(d);
    return {
      day, followers: series.followers?.[day] || current,
      impressions: series.impressions?.[day] || 0, reach: series.reach?.[day] || 0,
      engagement: series.engagement?.[day] || 0, clicks: series.clicks?.[day] || 0,
    };
  });
  return { rows, profile: { followers: current, avatarUrl: info.picture?.data?.url || null } };
}

/* ---------- Comentários ---------- */

async function instagramComments(profile, token) {
  const ig = profile.external_id;
  const own = profile.handle.replace(/^@/, '');
  const media = await graph(`/${ig}/media`, { token, query: { fields: 'id,caption,comments_count', limit: 10 } });
  const items = [];
  for (const m of media.data || []) {
    if (!m.comments_count) continue;
    const c = await graph(`/${m.id}/comments`, { token, query: { fields: 'id,text,username,timestamp,replies{username}', limit: 50 } });
    for (const cm of c.data || []) {
      if (cm.username === own) continue;
      const answered = (cm.replies?.data || []).some((r) => r.username === own);
      items.push({ externalId: cm.id, kind: 'comment', author: cm.username, body: cm.text, createdAt: cm.timestamp, context: (m.caption || '').slice(0, 120), answered });
    }
  }
  return items;
}

async function facebookComments(profile, token) {
  const page = profile.external_id;
  const feed = await graph(`/${page}/feed`, {
    token, query: { fields: 'id,message,comments.limit(50){id,message,from,created_time,comments.limit(20){from}}', limit: 10 },
  });
  const items = [];
  for (const p of feed.data || []) {
    for (const cm of p.comments?.data || []) {
      if (cm.from?.id === page) continue;
      const answered = (cm.comments?.data || []).some((r) => r.from?.id === page);
      items.push({ externalId: cm.id, kind: 'comment', author: cm.from?.name || 'Usuário do Facebook', body: cm.message || '', createdAt: cm.created_time, context: (p.message || '').slice(0, 120), answered });
    }
  }
  return items;
}

async function replyInstagram(commentId, message, token) {
  return graph(`/${commentId}/replies`, { method: 'POST', token, form: { message } });
}

async function replyFacebook(commentId, message, token) {
  return graph(`/${commentId}/comments`, { method: 'POST', token, form: { message } });
}

// Callback de exclusão de dados exigido pela Meta: valida o signed_request do app.
function parseSignedRequest(signed) {
  const [sig, payload] = String(signed || '').split('.');
  if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', config.meta().appSecret).update(payload).digest();
  const given = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

module.exports = {
  SCOPES, authUrl, exchangeCode, publishInstagram, publishFacebook, instagramMetrics, facebookMetrics,
  instagramComments, facebookComments, replyInstagram, replyFacebook, parseSignedRequest,
};
