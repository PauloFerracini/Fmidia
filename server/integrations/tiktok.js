const { config } = require('../config');
const { request, poll, IntegrationError } = require('./http');
const { isVideo } = require('../networks');

const API = 'https://open.tiktokapis.com';
// video.publish exige auditoria do app no TikTok para postar publicamente;
// antes disso, os posts só podem ser privados (SELF_ONLY).
const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list', 'video.publish'];

const redirectUri = () => `${config.publicUrl()}/api/oauth/tiktok/callback`;

function authUrl(state) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.searchParams.set('client_key', config.tiktok().clientKey);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(form) {
  const { clientKey, clientSecret } = config.tiktok();
  const { data } = await request(`${API}/v2/oauth/token/`, { method: 'POST', form: { client_key: clientKey, client_secret: clientSecret, ...form } });
  if (data.error || !data.access_token) {
    throw new IntegrationError(data.error_description || data.error || 'Falha ao obter token do TikTok', {
      code: data.error, auth: ['invalid_grant', 'invalid_request'].includes(data.error),
    });
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + data.expires_in * 1000).toISOString(),
    refreshExpiresAt: new Date(now + data.refresh_expires_in * 1000).toISOString(),
    openId: data.open_id,
    scope: data.scope,
  };
}

const exchangeCode = (code) => tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
const refresh = (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

async function revoke(token) {
  const { clientKey, clientSecret } = config.tiktok();
  await request(`${API}/v2/oauth/revoke/`, { method: 'POST', form: { client_key: clientKey, client_secret: clientSecret, token } });
}

async function api(path, token, { method = 'POST', query, json } = {}) {
  const { status, data } = await request(`${API}${path}`, { method, query, json, headers: { Authorization: `Bearer ${token}` } });
  const code = data.error?.code;
  if (code && code !== 'ok') {
    throw new IntegrationError(data.error.message || code, {
      status, code, auth: ['access_token_invalid', 'scope_not_authorized', 'scope_permission_missed'].includes(code),
    });
  }
  if (status >= 400) throw new IntegrationError(`API do TikTok respondeu ${status}`, { status });
  return data.data || {};
}

async function userInfo(token) {
  const fields = 'open_id,avatar_url,display_name,username,follower_count,likes_count,video_count';
  return (await api('/v2/user/info/', token, { method: 'GET', query: { fields } })).user || {};
}

async function account(tokens) {
  const u = await userInfo(tokens.accessToken);
  return {
    network: 'tiktok', externalId: tokens.openId || u.open_id, handle: u.username ? `@${u.username}` : u.display_name,
    displayName: u.display_name, followers: u.follower_count || 0, avatarUrl: u.avatar_url || null,
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt, refreshExpiresAt: tokens.refreshExpiresAt, meta: {},
  };
}

async function publish(profile, post, token) {
  const creator = await api('/v2/post/publish/creator_info/query/', token, { json: {} });
  const options = creator.privacy_level_options || [];
  const wanted = config.tiktok().privacy;
  const privacy = options.includes(wanted) ? wanted : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
  if (!privacy) throw new IntegrationError('A conta do TikTok não está habilitada para publicar agora');
  const common = { privacy_level: privacy, disable_comment: Boolean(creator.comment_disabled) };

  let init;
  if (isVideo(post.media[0])) {
    init = await api('/v2/post/publish/video/init/', token, {
      json: {
        post_info: { ...common, title: post.caption, disable_duet: Boolean(creator.duet_disabled), disable_stitch: Boolean(creator.stitch_disabled) },
        source_info: { source: 'PULL_FROM_URL', video_url: post.media[0] },
      },
    });
  } else {
    init = await api('/v2/post/publish/content/init/', token, {
      json: {
        post_info: { ...common, title: post.caption.split('\n')[0].slice(0, 90), description: post.caption, auto_add_music: true },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: post.media },
        post_mode: 'DIRECT_POST', media_type: 'PHOTO',
      },
    });
  }

  const publishId = init.publish_id;
  const final = await poll(async () => {
    const s = await api('/v2/post/publish/status/fetch/', token, { json: { publish_id: publishId } });
    if (s.status === 'PUBLISH_COMPLETE') return s;
    if (s.status === 'FAILED') throw new IntegrationError(`O TikTok recusou a publicação: ${s.fail_reason || 'motivo não informado'}`);
    return undefined;
  }, 'o TikTok processar a publicação');

  // O nome do campo vem assim mesmo da API ("publicaly"). Posts privados não têm ID público.
  const postId = final.publicaly_available_post_id?.[0];
  const user = (creator.creator_username || profile.handle || '').replace(/^@/, '');
  return {
    externalId: postId ? String(postId) : publishId,
    url: postId && user ? `https://www.tiktok.com/@${user}/${isVideo(post.media[0]) ? 'video' : 'photo'}/${postId}` : null,
  };
}

// O TikTok não oferece insights diários para contas comuns: medimos a variação diária
// das visualizações e interações somadas dos vídeos recentes a partir da conexão.
async function metrics(profile, token) {
  const u = await userInfo(token);
  let views = 0, interactions = 0, cursor;
  for (let page = 0; page < 5; page++) {
    const r = await api('/v2/video/list/', token, {
      query: { fields: 'id,view_count,like_count,comment_count,share_count' },
      json: { max_count: 20, ...(cursor && { cursor }) },
    });
    for (const v of r.videos || []) {
      views += v.view_count || 0;
      interactions += (v.like_count || 0) + (v.comment_count || 0) + (v.share_count || 0);
    }
    if (!r.has_more) break;
    cursor = r.cursor;
  }
  const today = new Date().toISOString().slice(0, 10);
  const meta = JSON.parse(profile.meta || '{}');
  const snapshots = meta.snapshots || {};
  const previousDay = Object.keys(snapshots).filter((d) => d < today).sort().pop();
  const prev = previousDay ? snapshots[previousDay] : null;
  snapshots[today] = { views, interactions };
  for (const d of Object.keys(snapshots).sort().slice(0, -7)) delete snapshots[d];

  const dv = prev ? Math.max(0, views - prev.views) : 0;
  const di = prev ? Math.max(0, interactions - prev.interactions) : 0;
  return {
    rows: [{ day: today, followers: u.follower_count || 0, impressions: dv, reach: dv, engagement: di, clicks: 0 }],
    profile: { followers: u.follower_count || 0, avatarUrl: u.avatar_url || null },
    meta: { ...meta, snapshots },
  };
}

module.exports = { SCOPES, authUrl, exchangeCode, refresh, revoke, account, publish, metrics };
