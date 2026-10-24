const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { runDuePosts } = require('../server/scheduler');

async function setup() {
  const db = openDb(':memory:');
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    return async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(base + path, {
        method, body: body && JSON.stringify(body),
        headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    };
  };
  return { db, server, client };
}

test('fluxo completo: marca, perfil, post, aprovação e publicação', async (t) => {
  const { db, server, client } = await setup();
  t.after(() => server.close());
  const api = client();

  assert.equal((await api('/brands')).status, 401);
  assert.equal((await api('/auth/register', { method: 'POST', body: { name: 'Ana', email: 'Ana@x.com', password: '123456' } })).status, 201);
  assert.equal((await api('/auth/me')).body.email, 'ana@x.com');

  const brand = (await api('/brands', { method: 'POST', body: { name: 'Padaria' } })).body;
  const ig = (await api(`/brands/${brand.id}/profiles`, { method: 'POST', body: { network: 'instagram', handle: 'padaria' } })).body;
  const x = (await api(`/brands/${brand.id}/profiles`, { method: 'POST', body: { network: 'x', handle: '@padaria' } })).body;
  assert.equal(ig.handle, '@padaria');

  // X não aceita stories; legenda longa estoura o limite do X.
  let r = await api(`/brands/${brand.id}/posts`, { method: 'POST', body: { caption: 'oi', format: 'stories', profileIds: [x.id] } });
  assert.equal(r.status, 400);
  r = await api(`/brands/${brand.id}/posts`, { method: 'POST', body: { caption: 'a'.repeat(300), profileIds: [x.id] } });
  assert.match(r.body.error, /280/);

  const future = new Date(Date.now() + 3600e3).toISOString();
  const post = (await api(`/brands/${brand.id}/posts`, { method: 'POST', body: { caption: 'Pão quentinho!', profileIds: [ig.id, x.id], scheduledAt: future } })).body;
  assert.equal(post.status, 'draft');
  assert.equal(post.targets.length, 2);

  // Aprovação pública: reprovar exige comentário; aprovar com data já agenda.
  const { approvalUrl } = (await api(`/brands/${brand.id}/posts/${post.id}/request-approval`, { method: 'POST' })).body;
  const token = approvalUrl.split('t=')[1];
  const anon = client();
  assert.equal((await anon(`/approval/${token}`)).body.brand_name, 'Padaria');
  assert.equal((await anon(`/approval/${token}`, { method: 'POST', body: { decision: 'reject' } })).status, 400);
  assert.equal((await anon(`/approval/${token}`, { method: 'POST', body: { decision: 'approve' } })).body.status, 'scheduled');
  assert.equal((await anon(`/approval/${token}`, { method: 'POST', body: { decision: 'approve' } })).status, 409);

  // Ainda não está na hora; depois de 2h deve publicar nas duas redes.
  assert.equal(runDuePosts(db), 0);
  assert.equal(runDuePosts(db, new Date(Date.now() + 7200e3)), 1);
  const published = (await api(`/brands/${brand.id}/posts/${post.id}`)).body;
  assert.equal(published.status, 'published');
  assert.ok(published.targets.every((t) => t.external_id));
  assert.equal((await api(`/brands/${brand.id}/posts/${post.id}`, { method: 'PUT', body: { caption: 'x' } })).status, 409);

  const analytics = (await api(`/brands/${brand.id}/analytics?days=30`)).body;
  assert.equal(analytics.series.length, 30);
  assert.equal(analytics.byProfile.length, 2);
  assert.ok(analytics.totals.impressions > 0);
});

test('permissões por marca', async (t) => {
  const { server, client } = await setup();
  t.after(() => server.close());
  const owner = client(), viewer = client(), stranger = client();
  await owner('/auth/register', { method: 'POST', body: { name: 'Dona', email: 'dona@x.com', password: '123456' } });
  await viewer('/auth/register', { method: 'POST', body: { name: 'Leitor', email: 'leitor@x.com', password: '123456' } });
  await stranger('/auth/register', { method: 'POST', body: { name: 'Fora', email: 'fora@x.com', password: '123456' } });
  const brand = (await owner('/brands', { method: 'POST', body: { name: 'Loja' } })).body;

  assert.equal((await stranger(`/brands/${brand.id}/posts`)).status, 404);
  assert.equal((await owner(`/brands/${brand.id}/members`, { method: 'POST', body: { email: 'leitor@x.com', role: 'viewer' } })).status, 201);
  assert.equal((await viewer(`/brands/${brand.id}/posts`)).status, 200);
  assert.equal((await viewer(`/brands/${brand.id}/profiles`, { method: 'POST', body: { network: 'instagram', handle: 'a' } })).status, 403);

  const me = (await owner('/auth/me')).body;
  assert.equal((await owner(`/brands/${brand.id}/members/${me.id}`, { method: 'DELETE' })).status, 400);
});

test('login inválido e caixa de entrada', async (t) => {
  const { db, server, client } = await setup();
  t.after(() => server.close());
  const api = client();
  await api('/auth/register', { method: 'POST', body: { name: 'B', email: 'b@x.com', password: '123456' } });
  assert.equal((await client()('/auth/login', { method: 'POST', body: { email: 'b@x.com', password: 'errada' } })).status, 401);

  const brand = (await api('/brands', { method: 'POST', body: { name: 'M' } })).body;
  const p = (await api(`/brands/${brand.id}/profiles`, { method: 'POST', body: { network: 'facebook', handle: 'm' } })).body;
  db.prepare("INSERT INTO inbox (profile_id, kind, author, body) VALUES (?, 'comment', 'fulano', 'Oi!')").run(p.id);
  const [item] = (await api(`/brands/${brand.id}/inbox?status=open`)).body;
  assert.equal(item.author, 'fulano');
  await api(`/brands/${brand.id}/inbox/${item.id}/reply`, { method: 'POST', body: { reply: 'Olá!' } });
  assert.equal((await api(`/brands/${brand.id}/inbox?status=open`)).body.length, 0);
  assert.equal((await api(`/brands/${brand.id}/inbox?status=answered`)).body[0].reply, 'Olá!');
});
