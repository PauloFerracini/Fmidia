const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.FMIDIA_SECRET = 'teste';
process.env.FMIDIA_POLL_MS = '1';
process.env.PUBLIC_URL = 'https://fmidia.test';
process.env.META_APP_ID = 'app123';
process.env.META_APP_SECRET = 'metasecret';
process.env.TIKTOK_CLIENT_KEY = 'ttkey';
process.env.TIKTOK_CLIENT_SECRET = 'ttsecret';

const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { runDuePosts, recoverInterrupted } = require('../server/scheduler');
const { decrypt } = require('../server/secrets');
const { checkMedia } = require('../server/networks');

/* ---------- APIs externas simuladas ---------- */
const realFetch = globalThis.fetch;
let routes = [];
const calls = [];
// mock(method, regex, handler(url, body) => json). Rotas mais recentes têm prioridade.
const mock = (method, re, fn) => routes.unshift({ method, re, fn });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const method = init.method || 'GET';
  let body = {};
  if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
  else if (typeof init.body === 'string') body = JSON.parse(init.body);
  calls.push({ method, url, body, headers: init.headers || {} });
  const route = routes.find((r) => r.method === method && r.re.test(url.host + url.pathname));
  if (!route) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  const out = await route.fn(url, body);
  return new Response(JSON.stringify(out), { status: out?.error && out.error.code !== 'ok' ? 400 : 200 });
};
const callsTo = (re, method) => calls.filter((c) => re.test(c.url.host + c.url.pathname) && (!method || c.method === method));

async function setup() {
  routes = [];
  calls.length = 0;
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = async (path, { method = 'GET', body, form } = {}) => {
    const res = await realFetch(base + path, {
      method, redirect: 'manual',
      body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, location: res.headers.get('location') };
  };
  await api('/api/auth/register', { method: 'POST', body: { name: 'Ana', email: 'ana@x.com', password: '123456' } });
  const brand = (await api('/api/brands', { method: 'POST', body: { name: 'Padaria' } })).body;
  return { db, server, api, brand };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function mockMetaLogin() {
  mock('GET', /graph\.facebook\.com\/v[\d.]+\/oauth\/access_token$/, (url) =>
    url.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'LONG_USER' } : { access_token: 'SHORT_USER' });
  mock('GET', /\/me$/, () => ({ id: 'U1', name: 'Ana' }));
  mock('GET', /\/me\/accounts$/, () => ({
    data: [{
      id: 'PAGE1', name: 'Padaria', username: 'padaria', access_token: 'PAGE_TOKEN', followers_count: 900,
      instagram_business_account: { id: 'IG1', username: 'padaria.ig', followers_count: 1500 },
    }],
  }));
}

async function connectMeta(api, brand) {
  mockMetaLogin();
  const start = await api(`/api/oauth/meta/start?brandId=${brand.id}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.location);
  assert.equal(auth.host, 'www.facebook.com');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://fmidia.test/api/oauth/meta/callback');
  assert.match(auth.searchParams.get('scope'), /instagram_content_publish/);

  const cb = await api(`/api/oauth/meta/callback?code=CODE&state=${auth.searchParams.get('state')}`);
  const pendingId = cb.location.match(/#\/conectar\/(\w+)/)[1];
  const pending = (await api(`/api/oauth/pending/${pendingId}`)).body;
  assert.deepEqual(pending.accounts.map((a) => `${a.network} ${a.handle}`), ['facebook @padaria', 'instagram @padaria.ig']);
  assert.ok(!JSON.stringify(pending).includes('PAGE_TOKEN'));

  const done = await api(`/api/oauth/pending/${pendingId}`, { method: 'POST', body: { indexes: [0, 1] } });
  assert.equal(done.body.connected, 2);
  await settle();
  const profiles = (await api(`/api/brands/${brand.id}/profiles`)).body;
  return { fb: profiles.find((p) => p.network === 'facebook'), ig: profiles.find((p) => p.network === 'instagram'), profiles };
}

test('Meta: login, escolha de contas e tokens cifrados', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  const { fb, ig, profiles } = await connectMeta(api, brand);

  assert.equal(ig.mode, 'live');
  assert.equal(ig.followers, 1500);
  assert.ok(profiles.every((p) => !('access_token' in p)), 'tokens nunca vão para o navegador');
  const row = db.prepare('SELECT access_token FROM profiles WHERE id = ?').get(ig.id);
  assert.match(row.access_token, /^v1:/);
  assert.equal(decrypt(row.access_token), 'PAGE_TOKEN');

  // State reutilizado ou de outro fluxo é recusado.
  const replay = await api('/api/oauth/meta/callback?code=X&state=inexistente');
  assert.match(new URLSearchParams(replay.location.split('?')[1]).get('erro'), /expirada/);

  // Reconectar a mesma conta atualiza o perfil em vez de duplicar.
  await connectMeta(api, brand);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 2);
  assert.ok(fb);
});

test('Meta: publica carrossel no Instagram e várias fotos no Facebook', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  const { fb, ig } = await connectMeta(api, brand);

  let n = 0;
  const polled = {};
  mock('POST', /\/IG1\/media$/, () => ({ id: `c${++n}` }));
  mock('GET', /\/c\d+$/, (url) => {
    const id = url.pathname.split('/').pop();
    polled[id] = (polled[id] || 0) + 1;
    return { status_code: polled[id] < 2 ? 'IN_PROGRESS' : 'FINISHED' };
  });
  mock('POST', /\/IG1\/media_publish$/, () => ({ id: 'IGPOST' }));
  mock('GET', /\/IGPOST$/, () => ({ permalink: 'https://instagram.com/p/abc' }));
  let photo = 0;
  mock('POST', /\/PAGE1\/photos$/, () => ({ id: `ph${++photo}` }));
  mock('POST', /\/PAGE1\/feed$/, () => ({ id: 'PAGE1_POST' }));

  const media = ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'];
  const post = (await api(`/api/brands/${brand.id}/posts`, {
    method: 'POST', body: { caption: 'Novidades!', format: 'carousel', mediaUrls: media, profileIds: [ig.id, fb.id] },
  })).body;
  await api(`/api/brands/${brand.id}/posts/${post.id}/schedule`, { method: 'POST', body: { now: true } });
  assert.equal(await runDuePosts(db), 1);

  const published = (await api(`/api/brands/${brand.id}/posts/${post.id}`)).body;
  assert.equal(published.status, 'published', JSON.stringify(published.targets));
  const igT = published.targets.find((x) => x.network === 'instagram');
  assert.equal(igT.external_id, 'IGPOST');
  assert.equal(igT.url, 'https://instagram.com/p/abc');

  const igCalls = callsTo(/\/IG1\/media$/, 'POST');
  assert.equal(igCalls.length, 3);
  assert.equal(igCalls[0].body.is_carousel_item, 'true');
  assert.equal(igCalls[2].body.media_type, 'CAROUSEL');
  assert.equal(igCalls[2].body.children, 'c1,c2');
  assert.equal(igCalls[2].body.access_token, 'PAGE_TOKEN');
  assert.equal(callsTo(/\/IG1\/media_publish$/)[0].body.creation_id, 'c3');

  const feed = callsTo(/\/PAGE1\/feed$/, 'POST')[0].body;
  assert.equal(feed.message, 'Novidades!');
  assert.deepEqual([feed['attached_media[0]'], feed['attached_media[1]']], ['{"media_fbid":"ph1"}', '{"media_fbid":"ph2"}']);
  assert.ok(callsTo(/\/PAGE1\/photos$/).every((c) => c.body.published === 'false'));
});

test('Meta: token revogado marca o perfil para reconexão', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  const { ig } = await connectMeta(api, brand);
  mock('POST', /\/IG1\/media$/, () => ({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }));

  const post = (await api(`/api/brands/${brand.id}/posts`, {
    method: 'POST', body: { caption: 'oi', mediaUrls: ['https://cdn.test/1.jpg'], profileIds: [ig.id] },
  })).body;
  await api(`/api/brands/${brand.id}/posts/${post.id}/schedule`, { method: 'POST', body: { now: true } });
  await runDuePosts(db);

  const failed = (await api(`/api/brands/${brand.id}/posts/${post.id}`)).body;
  assert.equal(failed.status, 'failed');
  assert.match(failed.targets[0].error, /access token/);
  const profile = (await api(`/api/brands/${brand.id}/profiles`)).body.find((p) => p.id === ig.id);
  assert.equal(profile.status, 'reauth');
  const again = await api(`/api/brands/${brand.id}/posts`, { method: 'POST', body: { caption: 'oi', mediaUrls: ['https://cdn.test/1.jpg'], profileIds: [ig.id] } });
  assert.match(again.body.error, /Reconecte/);
});

test('Meta: sincroniza comentários e responde pela API', async (t) => {
  const { server, api, brand } = await setup();
  t.after(() => server.close());
  const { ig } = await connectMeta(api, brand);
  mock('GET', /\/IG1\/media$/, () => ({ data: [{ id: 'M1', caption: 'Pão de queijo', comments_count: 2 }] }));
  mock('GET', /\/M1\/comments$/, () => ({
    data: [
      { id: 'CM1', text: 'Que delícia! Entregam?', username: 'cliente1', timestamp: '2026-10-20T10:00:00+0000' },
      { id: 'CM2', text: 'obrigado!', username: 'padaria.ig', timestamp: '2026-10-20T11:00:00+0000' },
    ],
  }));
  mock('POST', /\/CM1\/replies$/, () => ({ id: 'R1' }));

  const sync = await api(`/api/brands/${brand.id}/profiles/${ig.id}/sync`, { method: 'POST' });
  assert.equal(sync.body.newComments, 1, 'comentário da própria conta é ignorado');
  const [item] = (await api(`/api/brands/${brand.id}/inbox?status=open`)).body;
  assert.equal(item.author, 'cliente1');
  assert.equal(item.context, 'Pão de queijo');

  await api(`/api/brands/${brand.id}/inbox/${item.id}/reply`, { method: 'POST', body: { reply: 'Entregamos sim!' } });
  assert.equal(callsTo(/\/CM1\/replies$/)[0].body.message, 'Entregamos sim!');
  // Sincronizar de novo não duplica.
  assert.equal((await api(`/api/brands/${brand.id}/profiles/${ig.id}/sync`, { method: 'POST' })).body.newComments, 0);
});

test('Meta: callback de exclusão de dados', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  await connectMeta(api, brand);
  const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = b64(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'U1' }));
  const sig = b64(crypto.createHmac('sha256', 'metasecret').update(payload).digest());

  assert.equal((await api('/api/oauth/meta/data-deletion', { method: 'POST', form: { signed_request: `${sig}x.${payload}` } })).status, 400);
  const ok = await api('/api/oauth/meta/data-deletion', { method: 'POST', form: { signed_request: `${sig}.${payload}` } });
  assert.ok(ok.body.confirmation_code);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE mode = 'live'").get().n, 0);
});

test('TikTok: conecta, publica vídeo privado e renova token expirado', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  let issued = 0;
  mock('POST', /open\.tiktokapis\.com\/v2\/oauth\/token\/$/, () => ({
    access_token: `TT_ACCESS_${++issued}`, refresh_token: 'TT_REFRESH', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'OPEN1', scope: 'video.publish',
  }));
  mock('GET', /\/v2\/user\/info\/$/, () => ({ data: { user: { open_id: 'OPEN1', display_name: 'Padaria', username: 'padaria.tt', follower_count: 4200 } }, error: { code: 'ok' } }));

  const start = await api(`/api/oauth/tiktok/start?brandId=${brand.id}`);
  const auth = new URL(start.location);
  assert.equal(auth.host, 'www.tiktok.com');
  assert.equal(auth.searchParams.get('client_key'), 'ttkey');
  const cb = await api(`/api/oauth/tiktok/callback?code=C&state=${auth.searchParams.get('state')}`);
  assert.equal(new URLSearchParams(cb.location.split('?')[1]).get('ok'), 'TikTok @padaria.tt conectado');
  await settle();
  const tt = (await api(`/api/brands/${brand.id}/profiles`)).body[0];
  assert.equal(tt.handle, '@padaria.tt');

  // App ainda não auditado: só SELF_ONLY disponível; a conta desativou duetos.
  mock('POST', /\/v2\/post\/publish\/creator_info\/query\/$/, () => ({
    data: { creator_username: 'padaria.tt', creator_nickname: 'Padaria', privacy_level_options: ['SELF_ONLY'], duet_disabled: true, max_video_post_duration_sec: 300 },
    error: { code: 'ok' },
  }));
  const info = (await api(`/api/brands/${brand.id}/profiles/${tt.id}/tiktok-creator`)).body;
  assert.deepEqual(info.privacyOptions, ['SELF_ONLY']);
  assert.equal(info.nickname, 'Padaria');
  assert.equal(info.duetDisabled, true);
  assert.equal(info.maxVideoDurationSec, 300);
  mock('POST', /\/v2\/post\/publish\/video\/init\/$/, () => ({ data: { publish_id: 'v_pub_1' }, error: { code: 'ok' } }));
  let checks = 0;
  mock('POST', /\/v2\/post\/publish\/status\/fetch\/$/, () => ({ data: { status: ++checks < 3 ? 'PROCESSING_DOWNLOAD' : 'PUBLISH_COMPLETE' }, error: { code: 'ok' } }));

  // Força o token a parecer expirado para testar a renovação.
  db.prepare('UPDATE profiles SET token_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), tt.id);
  const post = (await api(`/api/brands/${brand.id}/posts`, {
    method: 'POST', body: {
      caption: 'Bastidores da fornada', format: 'reels', mediaUrls: ['https://cdn.test/v.mp4'], profileIds: [tt.id],
      tiktok: { [tt.id]: { privacy: 'SELF_ONLY', allowComment: true, allowDuet: true, commercial: true, yourBrand: true } },
    },
  })).body;
  assert.deepEqual(post.targets[0].options, {
    privacy: 'SELF_ONLY', allowComment: true, allowDuet: true, allowStitch: false, commercial: true, yourBrand: true, brandedContent: false,
  });
  await api(`/api/brands/${brand.id}/posts/${post.id}/schedule`, { method: 'POST', body: { now: true } });
  await runDuePosts(db);

  const published = (await api(`/api/brands/${brand.id}/posts/${post.id}`)).body;
  assert.equal(published.status, 'published', JSON.stringify(published.targets));
  assert.equal(published.targets[0].external_id, 'v_pub_1');
  const init = callsTo(/\/video\/init\/$/)[0];
  assert.equal(init.body.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(init.body.post_info.disable_comment, false, 'comentários liberados pelo usuário');
  assert.equal(init.body.post_info.disable_duet, true, 'a conta desativou duetos');
  assert.equal(init.body.post_info.disable_stitch, true, 'costura não marcada');
  assert.equal(init.body.post_info.brand_organic_toggle, true);
  assert.equal(init.body.post_info.brand_content_toggle, false);
  assert.equal(init.body.source_info.video_url, 'https://cdn.test/v.mp4');
  assert.equal(init.headers.Authorization, 'Bearer TT_ACCESS_2', 'usa o token renovado');
  assert.equal(callsTo(/\/oauth\/token\/$/).at(-1).body.grant_type, 'refresh_token');
  assert.equal(checks, 3);
});

test('TikTok: escolhas do usuário são obrigatórias e conferidas na publicação', async (t) => {
  const { db, server, api, brand } = await setup();
  t.after(() => server.close());
  const tt = (await api(`/api/brands/${brand.id}/profiles`, { method: 'POST', body: { network: 'tiktok', handle: 'demo' } })).body;
  const base = { caption: 'Fotos', format: 'carousel', mediaUrls: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'], profileIds: [tt.id] };
  const create = (tiktok) => api(`/api/brands/${brand.id}/posts`, { method: 'POST', body: { ...base, tiktok } });

  assert.match((await create()).body.error, /quem pode ver/, 'sem privacidade padrão');
  assert.match((await create({ [tt.id]: { privacy: 'PUBLIC_TO_EVERYONE', commercial: true } })).body.error, /Sua marca/);
  assert.match((await create({ [tt.id]: { privacy: 'SELF_ONLY', commercial: true, brandedContent: true } })).body.error, /não pode ser privado/);
  const ok = (await create({ [tt.id]: { privacy: 'FOLLOWER_OF_CREATOR', allowDuet: true, allowStitch: true } })).body;
  assert.equal(ok.targets[0].options.allowDuet, false, 'post de fotos não tem dueto');

  // Editar sem mandar `tiktok` mantém as escolhas já salvas.
  const edited = (await api(`/api/brands/${brand.id}/posts/${ok.id}`, { method: 'PUT', body: { caption: 'Fotos novas' } })).body;
  assert.equal(edited.targets[0].options.privacy, 'FOLLOWER_OF_CREATOR');

  // Conta real cujas opções mudaram depois do agendamento: falha com mensagem clara.
  db.prepare("UPDATE profiles SET mode = 'live', external_id = 'O1', access_token = ?, token_expires_at = ? WHERE id = ?")
    .run(require('../server/secrets').encrypt('T'), new Date(Date.now() + 864e5).toISOString(), tt.id);
  mock('POST', /creator_info\/query\/$/, () => ({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }));
  await api(`/api/brands/${brand.id}/posts/${ok.id}/schedule`, { method: 'POST', body: { now: true } });
  await runDuePosts(db);
  const failed = (await api(`/api/brands/${brand.id}/posts/${ok.id}`)).body;
  assert.equal(failed.status, 'failed');
  assert.match(failed.targets[0].error, /não está mais disponível/);
  assert.equal(callsTo(/content\/init\/$/).length, 0, 'nada é enviado ao TikTok');

  // Conta bloqueada pelo TikTok: o editor recebe o motivo.
  mock('POST', /creator_info\/query\/$/, () => ({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'x' } }));
  const blocked = await api(`/api/brands/${brand.id}/profiles/${tt.id}/tiktok-creator`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /limite diário/);
});

test('publicação interrompida não é repetida automaticamente', async (t) => {
  const { db, server } = await setup();
  t.after(() => server.close());
  db.prepare("INSERT INTO posts (brand_id, caption, status) VALUES (1, 'x', 'publishing')").run();
  assert.equal(recoverInterrupted(db), 1);
  assert.equal(db.prepare('SELECT status FROM posts').get().status, 'failed');
});

test('regras de mídia por rede', () => {
  assert.match(checkMedia('instagram', 'feed', []), /exige/);
  assert.equal(checkMedia('facebook', 'feed', []), null);
  assert.match(checkMedia('instagram', 'reels', ['https://a/x.jpg']), /vídeo/);
  assert.equal(checkMedia('instagram', 'reels', ['https://a/x.mp4']), null);
  assert.match(checkMedia('instagram', 'carousel', ['https://a/1.jpg']), /2 a 10/);
  assert.equal(checkMedia('instagram', 'carousel', ['https://a/1.jpg', 'https://a/2.mp4']), null);
  assert.match(checkMedia('facebook', 'carousel', ['https://a/1.jpg', 'https://a/2.mp4']), /apenas imagens/);
  assert.equal(checkMedia('tiktok', 'feed', ['https://a/1.jpg']), null);
  assert.match(checkMedia('tiktok', 'feed', ['https://a/1.mp4']), /Vídeo curto/);
});
