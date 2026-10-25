/* Fmidia — painel (SPA com rotas em hash). */
const state = { user: null, brands: [], brandId: null, networks: {}, formats: {}, live: {}, profiles: [] };

const STATUS = {
  draft: 'Rascunho', pending_approval: 'Aguardando aprovação', approved: 'Aprovado', rejected: 'Ajustes solicitados',
  scheduled: 'Agendado', publishing: 'Publicando', published: 'Publicado', failed: 'Falhou',
};
const isVideo = (url) => /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(url));
const mediaTag = (url, cls = '', attrs = '') => (isVideo(url)
  ? `<video class="${cls}" src="${esc(url)}" muted playsinline preload="metadata" ${attrs}></video>`
  : `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" ${attrs}>`);
const KIND = { comment: 'Comentário', message: 'Mensagem direta', mention: 'Menção' };

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');
const num = (n) => (n || 0).toLocaleString('pt-BR');
const pct = (n) => `${(n * 100).toFixed(2).replace('.', ',')}%`;
const dt = (iso, opts = { dateStyle: 'short', timeStyle: 'short' }) => (iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', opts) : '—');
const brand = () => state.brands.find((b) => b.id === state.brandId);
const canEdit = () => ['owner', 'editor'].includes(brand()?.role);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/entrar'; throw new Error('401'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro inesperado');
  return data;
}
const bapi = (path, opts) => api(`/brands/${state.brandId}${path}`, opts);

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

function modal(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="card modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) back.remove(); });
  document.body.append(back);
  return back;
}

function netIcon(network) {
  const n = state.networks[network] || { color: '#888', label: network };
  return `<span class="net" style="background:${n.color}" title="${esc(n.label)}">${esc(n.label[0])}</span>`;
}
const badge = (status) => `<span class="badge ${status}">${STATUS[status] || status}</span>`;
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
};

/* ---------- Inicialização ---------- */
async function init() {
  const [user, nets] = await Promise.all([api('/auth/me'), api('/networks')]);
  state.user = user; state.networks = nets.networks; state.formats = nets.formats; state.live = nets.live;
  $('#user-box').textContent = `${user.name} · ${user.email}`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#nav').onclick = () => $('#sidebar').classList.remove('open');
  $('#brand-select').onchange = (e) => selectBrand(Number(e.target.value));
  await loadBrands();
  window.addEventListener('hashchange', route);
  route();
}

async function loadBrands(preferId) {
  state.brands = await api('/brands');
  const saved = preferId || Number(localStorage.getItem('fm_brand'));
  state.brandId = state.brands.some((b) => b.id === saved) ? saved : state.brands[0]?.id ?? null;
  $('#brand-select').innerHTML = state.brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')
    + '<option value="new">+ Nova marca…</option>';
  if (state.brandId) $('#brand-select').value = state.brandId;
  $('#brand-dot').style.background = brand()?.color || 'var(--border)';
  if (state.brandId) await refreshBrandData();
}

async function selectBrand(id) {
  if (Number.isNaN(id)) { $('#brand-select').value = state.brandId ?? ''; return newBrandModal(); }
  state.brandId = id;
  try { localStorage.setItem('fm_brand', id); } catch {}
  $('#brand-dot').style.background = brand()?.color;
  await refreshBrandData();
  route();
}

async function refreshBrandData() {
  const [profiles, inbox] = await Promise.all([bapi('/profiles'), bapi('/inbox?status=open')]);
  state.profiles = profiles;
  const unread = inbox.filter((i) => !i.read).length;
  $('#inbox-count').hidden = !unread;
  $('#inbox-count').textContent = unread;
}

function newBrandModal() {
  const m = modal(`<h2>Nova marca</h2>
    <form id="nb"><div class="field"><label>Nome do cliente / marca</label><input name="name" required></div>
    <div class="field"><label>Cor</label><input name="color" type="color" value="#6d28d9" style="height:42px;padding:4px"></div>
    <p class="error-msg"></p><div class="row"><button class="btn primary">Criar marca</button><button type="button" class="btn" data-close>Cancelar</button></div></form>`);
  $('#nb', m).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const b = await api('/brands', { method: 'POST', body: { name: f.get('name'), color: f.get('color') } });
      m.remove(); await loadBrands(b.id); location.hash = '#/perfis'; route();
    } catch (err) { $('.error-msg', m).textContent = err.message; }
  };
}

const ROUTES = {
  dashboard: renderDashboard, calendario: renderCalendar, posts: renderPosts, novo: renderComposer, editar: renderComposer,
  inbox: renderInbox, relatorio: renderReport, perfis: renderProfiles, equipe: renderTeam, conectar: renderConnectPick,
};

async function route() {
  const [path, query] = location.hash.replace(/^#\//, '').split('?');
  const [name, arg] = (path || 'dashboard').split('/');
  // Retorno do login OAuth: #/perfis?ok=... ou ?erro=...
  if (query) {
    const q = new URLSearchParams(query);
    if (q.get('ok')) toast(`✓ ${q.get('ok')}`);
    if (q.get('erro')) toast(`⚠ ${q.get('erro')}`);
    history.replaceState(null, '', `#/${path}`);
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${name}`));
  if (!state.brandId) {
    view().innerHTML = `<div class="card empty"><h2>Bem-vindo à Fmidia 👋</h2><p>Comece criando a primeira marca (cliente) que você vai gerenciar.</p>
      <button class="btn primary" id="first-brand">Criar marca</button></div>`;
    $('#first-brand').onclick = newBrandModal;
    return;
  }
  view().innerHTML = '<p class="muted">Carregando…</p>';
  try { await (ROUTES[name] || renderDashboard)(arg); }
  catch (err) { if (err.message !== '401') view().innerHTML = `<div class="card empty">${esc(err.message)}</div>`; }
}

/* ---------- Visão geral ---------- */
function delta(cur, prev) {
  if (!prev) return '';
  const d = (cur - prev) / prev;
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(1).replace('.', ',')}%</span> <span class="hint">vs. período anterior</span>`;
}

function kpiCards(a) {
  const t = a.totals, p = a.previous;
  return `<div class="grid kpis">
    <div class="card kpi"><div class="label">Seguidores</div><div class="value">${num(t.followers)}</div><span class="delta ${t.followersGrowth >= 0 ? 'up' : 'down'}">${t.followersGrowth >= 0 ? '+' : ''}${num(t.followersGrowth)}</span> <span class="hint">no período</span></div>
    <div class="card kpi"><div class="label">Impressões</div><div class="value">${num(t.impressions)}</div>${delta(t.impressions, p.impressions)}</div>
    <div class="card kpi"><div class="label">Alcance</div><div class="value">${num(t.reach)}</div>${delta(t.reach, p.reach)}</div>
    <div class="card kpi"><div class="label">Engajamento</div><div class="value">${num(t.engagement)}</div>${delta(t.engagement, p.engagement)}</div>
    <div class="card kpi"><div class="label">Taxa de engajamento</div><div class="value">${pct(t.engagementRate)}</div><span class="hint">engajamento sobre o alcance</span></div>
    <div class="card kpi"><div class="label">Cliques</div><div class="value">${num(t.clicks)}</div>${delta(t.clicks, p.clicks)}</div>
  </div>`;
}

async function renderDashboard() {
  const days = Number(sessionStorage.getItem('fm_days')) || 30;
  const [a, upcoming] = await Promise.all([bapi(`/analytics?days=${days}`), bapi('/posts?status=scheduled')]);
  const metric = sessionStorage.getItem('fm_metric') || 'impressions';
  const METRICS = { followers: 'Seguidores', impressions: 'Impressões', reach: 'Alcance', engagement: 'Engajamento', clicks: 'Cliques' };
  view().innerHTML = `
    <div class="page-head"><h1>Visão geral</h1><span class="spacer"></span>
      <select id="days" style="width:auto">${[7, 30, 90].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Últimos ${d} dias</option>`).join('')}</select>
      ${canEdit() ? '<a class="btn primary" href="#/novo">+ Criar post</a>' : ''}</div>
    ${state.profiles.length ? '' : '<div class="card" style="margin-bottom:1em">Nenhum perfil conectado ainda. <a href="#/perfis">Conectar perfis →</a></div>'}
    ${kpiCards(a)}
    <div class="grid two-col" style="margin-top:1em">
      <div class="card chart"><div class="row" style="margin-bottom:.5em"><h3 style="margin:0">Evolução</h3><span class="spacer"></span>
        <select id="metric" style="width:auto">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        ${Charts.line(a.series, { key: metric })}</div>
      <div class="card"><h3>Engajamento por perfil</h3>
        ${Charts.bars(a.byProfile.map((p) => ({ ...p, label: `${state.networks[p.network]?.label} ${p.handle}`, color: state.networks[p.network]?.color })), { labelKey: 'label', valueKey: 'engagement', colorKey: 'color' }) || '<p class="muted">Sem perfis</p>'}</div>
    </div>
    <div class="card" style="margin-top:1em"><div class="row"><h3 style="margin:0">Próximas publicações</h3><span class="spacer"></span><a href="#/calendario">Ver calendário →</a></div>
      ${upcoming.length ? upcoming.slice(-5).reverse().map(postRow).join('') : '<p class="empty">Nada agendado. <a href="#/novo">Crie um post</a>.</p>'}</div>`;
  $('#days').onchange = (e) => { sessionStorage.setItem('fm_days', e.target.value); renderDashboard(); };
  $('#metric').onchange = (e) => { sessionStorage.setItem('fm_metric', e.target.value); renderDashboard(); };
  bindPostRows();
}

/* ---------- Posts ---------- */
function postRow(p) {
  return `<div class="post-item" style="padding:.8em 0;border-bottom:1px solid var(--border)">
    ${p.media?.length ? mediaTag(p.media[0], 'thumb') : '<div class="thumb"></div>'}
    <div style="min-width:0"><div class="row" style="gap:.4em">${badge(p.status)} ${p.targets.map((t) => netIcon(t.network)).join('')}
      <span class="hint">${esc(state.formats[p.format])}${p.media?.length > 1 ? ` · ${p.media.length} mídias` : ''} · ${dt(p.published_at || p.scheduled_at)}</span></div>
      <div class="caption">${esc(p.caption)}</div>
      ${p.approval_comment ? `<div class="hint">💬 Cliente: ${esc(p.approval_comment)}</div>` : ''}
      ${p.targets.filter((t) => t.error).map((t) => `<div class="hint" style="color:var(--danger)">⚠ ${esc(t.handle)}: ${esc(t.error)}</div>`).join('')}</div>
    <div class="actions row"><button class="btn small" data-open="${p.id}">Detalhes</button></div>
  </div>`;
}

function bindPostRows(root = view()) {
  root.querySelectorAll('[data-open]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openPost(Number(b.dataset.open)); }));
}

async function openPost(id) {
  const p = await bapi(`/posts/${id}`);
  const editable = canEdit() && ['draft', 'rejected', 'approved', 'scheduled', 'failed'].includes(p.status);
  const actions = [];
  if (canEdit()) {
    if (editable) actions.push(`<a class="btn" href="#/editar/${p.id}" data-close>Editar</a>`);
    if (['draft', 'rejected'].includes(p.status)) actions.push('<button class="btn" data-act="request-approval">Enviar para aprovação</button>');
    if (['draft', 'approved', 'failed'].includes(p.status) && p.scheduled_at) actions.push('<button class="btn primary" data-act="schedule">Agendar</button>');
    if (['draft', 'approved', 'failed'].includes(p.status)) actions.push('<button class="btn" data-act="now">Publicar agora</button>');
    if (p.status === 'scheduled') actions.push('<button class="btn" data-act="unschedule">Cancelar agendamento</button>');
    if (p.status !== 'publishing') actions.push('<button class="btn danger" data-act="delete">Excluir</button>');
  }
  const link = p.approval_token ? `${location.origin}/aprovar.html?t=${p.approval_token}` : null;
  const m = modal(`
    <div class="row">${badge(p.status)}<span class="hint">${esc(state.formats[p.format])}</span><span class="spacer"></span><button class="btn small" data-close>✕</button></div>
    <p class="muted" style="margin:.6em 0">${p.published_at ? 'Publicado em ' + dt(p.published_at) : p.scheduled_at ? 'Agendado para ' + dt(p.scheduled_at) : 'Sem data'}</p>
    ${p.media.length ? `<div class="media-strip">${p.media.map((u) => mediaTag(u, '', isVideo(u) ? 'controls' : '')).join('')}</div>` : ''}
    <p style="white-space:pre-wrap">${esc(p.caption)}</p>
    <div style="margin-bottom:1em">${p.targets.map((t) => `<div class="row" style="gap:.4em;margin:.25em 0">${netIcon(t.network)}
      <span class="hint">${esc(t.handle)}${t.mode === 'live' ? '' : ' (demonstração)'}</span>
      ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">ver na rede ↗</a>` : t.external_id ? '<span class="hint">✓ publicado</span>' : ''}
      ${t.error ? `<span class="hint" style="color:var(--danger)">⚠ ${esc(t.error)}</span>` : ''}</div>`).join('')}</div>
    ${p.approval_comment ? `<p class="reply"><strong>Comentário do cliente:</strong> ${esc(p.approval_comment)}</p>` : ''}
    ${link && p.status === 'pending_approval' ? `<div class="field"><label>Link de aprovação para o cliente</label><div class="row"><input readonly value="${esc(link)}" id="alink"><button class="btn small" id="copy">Copiar</button></div></div>` : ''}
    <p class="error-msg"></p>
    <div class="row">${actions.join('')}</div>`);
  $('#copy', m)?.addEventListener('click', () => { navigator.clipboard?.writeText(link); toast('Link copiado'); });
  m.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    try {
      if (act === 'delete') {
        if (!confirm('Excluir este post?')) return;
        await bapi(`/posts/${p.id}`, { method: 'DELETE' }); toast('Post excluído');
      } else if (act === 'request-approval') {
        const r = await bapi(`/posts/${p.id}/request-approval`, { method: 'POST' });
        navigator.clipboard?.writeText(location.origin + r.approvalUrl).catch(() => {});
        toast('Enviado para aprovação. Link copiado.');
      } else if (act === 'now') {
        await bapi(`/posts/${p.id}/schedule`, { method: 'POST', body: { now: true } }); toast('Na fila de publicação');
      } else {
        await bapi(`/posts/${p.id}/${act}`, { method: 'POST' }); toast(act === 'schedule' ? 'Post agendado' : 'Agendamento cancelado');
      }
      m.remove(); route();
    } catch (err) { $('.error-msg', m).textContent = err.message; }
  }));
}

async function renderPosts() {
  const status = sessionStorage.getItem('fm_status') || '';
  const posts = await bapi(`/posts${status ? `?status=${status}` : ''}`);
  view().innerHTML = `
    <div class="page-head"><h1>Posts</h1><span class="spacer"></span>
      <select id="status" style="width:auto"><option value="">Todos os status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${canEdit() ? '<a class="btn primary" href="#/novo">+ Criar post</a>' : ''}</div>
    <div class="card">${posts.length ? posts.map(postRow).join('') : '<p class="empty">Nenhum post encontrado.</p>'}</div>`;
  $('#status').onchange = (e) => { sessionStorage.setItem('fm_status', e.target.value); renderPosts(); };
  bindPostRows();
}

/* ---------- Calendário ---------- */
async function renderCalendar() {
  const cursor = new Date(sessionStorage.getItem('fm_month') || Date.now());
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const start = new Date(year, month, 1);
  start.setDate(1 - start.getDay());
  const end = new Date(start); end.setDate(start.getDate() + 42);
  const posts = await bapi(`/posts?from=${start.toISOString()}&to=${end.toISOString()}`);
  const byDay = {};
  for (const p of posts) {
    const d = new Date(p.scheduled_at || p.created_at);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    (byDay[k] ||= []).push(p);
  }
  const todayKey = (() => { const t = new Date(); return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`; })();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const items = (byDay[k] || []).sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    cells.push(`<div class="day ${d.getMonth() !== month ? 'other' : ''} ${k === todayKey ? 'today' : ''}" data-date="${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}">
      <span class="num">${d.getDate()}</span>
      ${items.map((p) => `<div class="chip ${p.status}" data-open="${p.id}" title="${esc(STATUS[p.status])}: ${esc(p.caption)}">${p.scheduled_at ? new Date(p.scheduled_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''} ${esc(p.caption)}</div>`).join('')}
    </div>`);
  }
  view().innerHTML = `
    <div class="page-head"><h1>${cursor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase())}</h1>
      <div class="row"><button class="btn small" data-m="-1">‹</button><button class="btn small" data-m="0">Hoje</button><button class="btn small" data-m="1">›</button></div>
      <span class="spacer"></span>${canEdit() ? '<a class="btn primary" href="#/novo">+ Criar post</a>' : ''}</div>
    <div class="row hint" style="margin-bottom:.75em">${Object.entries(STATUS).map(([k, v]) => `<span class="badge ${k}">${v}</span>`).join('')}</div>
    <div class="cal">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
    <p class="hint">Clique em um dia vazio para criar um post nessa data.</p>`;
  view().querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    const delta = Number(b.dataset.m);
    const next = delta === 0 ? new Date() : new Date(year, month + delta, 1);
    sessionStorage.setItem('fm_month', next.toISOString());
    renderCalendar();
  }));
  view().querySelectorAll('.day').forEach((el) => (el.onclick = () => {
    if (!canEdit()) return;
    sessionStorage.setItem('fm_newdate', el.dataset.date);
    location.hash = '#/novo';
  }));
  bindPostRows();
}

/* ---------- Criar / editar post ---------- */
async function renderComposer(editId) {
  if (!canEdit()) { view().innerHTML = '<div class="card empty">Você tem acesso somente leitura nesta marca.</div>'; return; }
  if (!state.profiles.length) {
    view().innerHTML = '<div class="card empty"><h2>Conecte um perfil primeiro</h2><p>Para criar posts, conecte ao menos uma rede social desta marca.</p><a class="btn primary" href="#/perfis">Conectar perfis</a></div>';
    return;
  }
  const post = editId ? await bapi(`/posts/${editId}`) : null;
  let defaultDate = '';
  const preset = sessionStorage.getItem('fm_newdate');
  if (!post && preset) { defaultDate = `${preset}T10:00`; sessionStorage.removeItem('fm_newdate'); }
  const selected = new Set(post ? post.targets.map((t) => t.id) : []);

  view().innerHTML = `
    <div class="page-head"><h1>${post ? 'Editar post' : 'Criar post'}</h1></div>
    <div class="grid composer">
      <form class="card" id="composer">
        <div class="field"><label>Publicar em</label><div class="profile-pick">
          ${state.profiles.map((p) => `<label title="${p.mode === 'live' ? 'Conta real' : 'Demonstração'}"><input type="checkbox" name="profile" value="${p.id}" data-net="${p.network}" ${selected.has(p.id) ? 'checked' : ''} ${p.status === 'reauth' ? 'disabled' : ''}>${netIcon(p.network)}${esc(p.handle)}${p.status === 'reauth' ? ' <span class="badge failed">reconectar</span>' : ''}</label>`).join('')}
        </div></div>
        <div class="field"><label for="format">Formato</label><select id="format" name="format">
          ${Object.entries(state.formats).map(([k, v]) => `<option value="${k}" ${post?.format === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="caption">Legenda</label><textarea id="caption" name="caption" placeholder="Escreva a legenda, hashtags e menções…">${esc(post?.caption || '')}</textarea>
          <div class="hint" id="limits"></div></div>
        <div class="field"><label for="media">Imagens ou vídeos <span class="hint">(um link por linha; no carrossel, na ordem de exibição)</span></label>
          <textarea id="media" name="media" style="min-height:70px" placeholder="https://…/foto.jpg">${esc((post?.media || []).join('\n'))}</textarea>
          <div class="row" style="margin-top:.4em"><label class="btn small" style="margin:0">⬆ Enviar arquivos<input type="file" id="upload" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple hidden></label>
            <span class="hint" id="upload-status"></span><span class="spacer"></span><a href="#" id="sample" class="hint">Usar imagem de exemplo</a></div>
          <div class="hint">Instagram aceita imagens só em JPEG. Vídeos: MP4 ou MOV. As redes baixam a mídia pelo link, então ele precisa ser público.</div></div>
        <div class="field"><label for="when">Data e hora da publicação</label><input id="when" name="when" type="datetime-local" value="${post ? toLocalInput(post.scheduled_at) : defaultDate}"></div>
        <p class="error-msg" id="err"></p>
        <div class="row">
          <button class="btn primary" data-then="schedule">Agendar</button>
          <button class="btn" data-then="approval">Salvar e enviar para aprovação</button>
          <button class="btn" data-then="draft">Salvar rascunho</button>
        </div>
      </form>
      <div class="preview"><div class="hint" style="margin-bottom:.4em">Prévia</div>
        <div class="phone"><div class="phone-head"><span class="avatar" style="background:${brand().color}"></span><span id="pv-handle">${esc(brand().name)}</span></div>
        <div class="media" id="pv-media">Sem mídia</div><div class="text" id="pv-text"></div></div></div>
    </div>`;

  const form = $('#composer');
  const update = () => {
    const caption = $('#caption').value;
    const picked = [...form.querySelectorAll('[name=profile]:checked')];
    const nets = [...new Set(picked.map((i) => i.dataset.net))];
    $('#limits').innerHTML = `${caption.length} caracteres` + nets.map((n) => {
      const net = state.networks[n];
      const over = caption.length > net.maxCaption;
      const bad = !net.formats.includes($('#format').value);
      return ` · <span style="color:${over || bad ? 'var(--danger)' : 'inherit'}">${net.label}: ${bad ? 'formato não suportado' : `${net.maxCaption - caption.length} restantes`}</span>`;
    }).join('');
    $('#pv-text').textContent = caption || 'Sua legenda aparece aqui.';
    const first = state.profiles.find((p) => p.id === Number(picked[0]?.value));
    $('#pv-handle').textContent = first ? first.handle : brand().name;
    const media = mediaList();
    $('#pv-media').innerHTML = media.length
      ? mediaTag(media[0], '', isVideo(media[0]) ? 'controls' : 'onerror="this.replaceWith(\'Não foi possível carregar a mídia\')"') + (media.length > 1 ? `<span class="media-count">1/${media.length}</span>` : '')
      : 'Sem mídia';
  };
  const mediaList = () => $('#media').value.split('\n').map((u) => u.trim()).filter(Boolean);
  const addMedia = (url) => { $('#media').value = [...mediaList(), url].join('\n'); update(); };
  form.addEventListener('input', update);
  $('#sample').onclick = (e) => { e.preventDefault(); addMedia(`https://picsum.photos/seed/${Date.now()}/1080/1080.jpg`); };
  $('#upload').onchange = async (e) => {
    const files = [...e.target.files];
    for (const [i, file] of files.entries()) {
      $('#upload-status').textContent = `Enviando ${i + 1} de ${files.length}…`;
      try {
        const res = await fetch(`/api/brands/${state.brandId}/media`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        addMedia(data.url);
      } catch (err) { toast(`${file.name}: ${err.message}`); }
    }
    $('#upload-status').textContent = '';
    e.target.value = '';
  };
  update();

  let then = 'draft';
  form.querySelectorAll('[data-then]').forEach((b) => b.addEventListener('click', () => (then = b.dataset.then)));
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#err').textContent = '';
    const when = $('#when').value;
    if (then === 'schedule' && !when) return ($('#err').textContent = 'Defina a data e hora para agendar');
    if (then === 'schedule' && new Date(when) < new Date()) return ($('#err').textContent = 'A data precisa estar no futuro');
    const body = {
      caption: $('#caption').value, mediaUrls: mediaList(), format: $('#format').value,
      scheduledAt: when ? new Date(when).toISOString() : null,
      profileIds: [...form.querySelectorAll('[name=profile]:checked')].map((i) => Number(i.value)),
    };
    try {
      const saved = post ? await bapi(`/posts/${post.id}`, { method: 'PUT', body }) : await bapi('/posts', { method: 'POST', body });
      if (then === 'schedule') { await bapi(`/posts/${saved.id}/schedule`, { method: 'POST' }); toast('Post agendado!'); }
      else if (then === 'approval') {
        const r = await bapi(`/posts/${saved.id}/request-approval`, { method: 'POST' });
        navigator.clipboard?.writeText(location.origin + r.approvalUrl).catch(() => {});
        toast('Enviado para aprovação. Link copiado.');
      } else toast('Rascunho salvo');
      location.hash = '#/calendario';
    } catch (err) { $('#err').textContent = err.message; }
  };
}

/* ---------- Caixa de entrada ---------- */
async function renderInbox() {
  const filter = sessionStorage.getItem('fm_inbox') || 'open';
  const items = await bapi(`/inbox${filter === 'all' ? '' : `?status=${filter}`}`);
  view().innerHTML = `
    <div class="page-head"><h1>Caixa de entrada</h1><span class="spacer"></span>
      <select id="filter" style="width:auto">${[['open', 'Sem resposta'], ['answered', 'Respondidas'], ['all', 'Todas']].map(([k, v]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="card">${items.length ? items.map((i) => `
      <div class="inbox-item ${i.read ? '' : 'unread'}" data-id="${i.id}">
        ${netIcon(i.network)}
        <div><div class="row" style="gap:.5em"><strong class="who">@${esc(i.author)}</strong><span class="badge">${KIND[i.kind]}</span><span class="hint">em ${esc(i.handle)} · ${dt(i.created_at)}</span></div>
          <div>${esc(i.body)}</div>
          ${i.context ? `<div class="hint">no post: “${esc(i.context)}”</div>` : ''}
          ${i.reply ? `<div class="reply"><strong>Sua resposta:</strong> ${esc(i.reply)} <span class="hint">· ${dt(i.replied_at)}</span></div>`
            : canEdit() ? `<form class="reply-box"><input placeholder="Escreva uma resposta…" required><button class="btn primary small">Responder</button></form>` : ''}
        </div></div>`).join('') : '<p class="empty">Tudo respondido por aqui 🎉</p>'}</div>`;
  $('#filter').onchange = (e) => { sessionStorage.setItem('fm_inbox', e.target.value); renderInbox(); };
  view().querySelectorAll('.inbox-item').forEach((el) => {
    const id = el.dataset.id;
    if (el.classList.contains('unread')) el.addEventListener('click', () => {
      el.classList.remove('unread'); bapi(`/inbox/${id}/read`, { method: 'POST' }).then(refreshBrandData);
    }, { once: true });
    const f = $('form', el);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      try { await bapi(`/inbox/${id}/reply`, { method: 'POST', body: { reply: $('input', f).value } }); toast('Resposta enviada'); await refreshBrandData(); renderInbox(); }
      catch (err) { toast(err.message); }
    };
  });
}

/* ---------- Relatório ---------- */
async function renderReport() {
  const days = Number(sessionStorage.getItem('fm_rdays')) || 30;
  const [a, published] = await Promise.all([bapi(`/analytics?days=${days}`), bapi('/posts?status=published')]);
  const inPeriod = published.filter((p) => p.published_at && p.published_at.slice(0, 10) >= a.since);
  const fmtDay = (d) => d.split('-').reverse().join('/');
  view().innerHTML = `
    <div class="page-head no-print"><h1>Relatório</h1><span class="spacer"></span>
      <select id="rdays" style="width:auto">${[7, 30, 90].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Últimos ${d} dias</option>`).join('')}</select>
      <button class="btn primary" onclick="print()">Exportar PDF</button></div>
    <div class="card" style="margin-bottom:1em"><div class="row"><span class="brand-dot" style="background:${brand().color};width:18px;height:18px"></span>
      <h2 style="margin:0">${esc(brand().name)}</h2><span class="spacer"></span><span class="muted">${fmtDay(a.since)} a ${fmtDay(a.until)}</span></div></div>
    ${kpiCards(a)}
    <div class="grid two-col" style="margin-top:1em">
      <div class="card chart"><h3>Seguidores</h3>${Charts.line(a.series, { key: 'followers', height: 180 })}</div>
      <div class="card chart"><h3>Engajamento</h3>${Charts.line(a.series, { key: 'engagement', color: '#db2777', height: 180 })}</div>
    </div>
    <div class="card" style="margin-top:1em"><h3>Desempenho por perfil</h3><div class="table-wrap"><table>
      <thead><tr><th>Perfil</th><th class="num">Seguidores</th><th class="num">Impressões</th><th class="num">Alcance</th><th class="num">Engajamento</th><th class="num">Taxa</th><th class="num">Cliques</th></tr></thead>
      <tbody>${a.byProfile.map((p) => `<tr><td><div class="row" style="gap:.4em">${netIcon(p.network)} ${esc(p.handle)}</div></td><td class="num">${num(p.followers)}</td><td class="num">${num(p.impressions)}</td><td class="num">${num(p.reach)}</td><td class="num">${num(p.engagement)}</td><td class="num">${pct(p.reach ? p.engagement / p.reach : 0)}</td><td class="num">${num(p.clicks)}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="card" style="margin-top:1em"><h3>Publicações no período (${inPeriod.length})</h3>
      ${inPeriod.length ? inPeriod.map(postRow).join('') : '<p class="muted">Nenhuma publicação no período.</p>'}</div>`;
  $('#rdays').onchange = (e) => { sessionStorage.setItem('fm_rdays', e.target.value); renderReport(); };
  view().querySelectorAll('.actions').forEach((el) => el.classList.add('no-print'));
  bindPostRows();
}

/* ---------- Perfis ---------- */
const LIVE_BUTTONS = [
  { provider: 'meta', label: 'Conectar Facebook e Instagram', nets: ['facebook', 'instagram'],
    hint: 'Entre com o Facebook e escolha as Páginas e contas profissionais do Instagram vinculadas a elas.' },
  { provider: 'tiktok', label: 'Conectar TikTok', nets: ['tiktok'], hint: 'Entre com a conta do TikTok que vai publicar.' },
];

async function renderProfiles() {
  await refreshBrandData();
  const liveNets = new Set(LIVE_BUTTONS.filter((b) => state.live[b.provider]).flatMap((b) => b.nets));
  view().innerHTML = `
    <div class="page-head"><h1>Perfis conectados</h1></div>
    <div class="card" style="margin-bottom:1em">
      ${state.profiles.length ? `<div class="table-wrap"><table class="profiles-table"><thead><tr><th>Rede</th><th>Perfil</th><th class="num">Seguidores</th><th>Situação</th><th></th></tr></thead><tbody>
        ${state.profiles.map((p) => `<tr><td><div class="row" style="gap:.4em">${netIcon(p.network)} <span class="net-label">${esc(state.networks[p.network]?.label)}</span></div></td>
        <td><div class="row" style="gap:.5em">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="" class="avatar-sm">` : ''}<div>${esc(p.handle)}${p.display_name && p.display_name !== p.handle ? `<div class="hint">${esc(p.display_name)}</div>` : ''}</div></div></td>
        <td class="num">${num(p.followers)}</td>
        <td>${p.mode !== 'live' ? '<span class="badge">Demonstração</span>'
          : p.status === 'reauth' ? '<span class="badge failed">Reconectar</span>' : '<span class="badge published">Conectado</span>'}
          ${p.last_error ? `<div class="hint" style="color:var(--danger);max-width:280px">${esc(p.last_error)}</div>` : p.last_synced_at ? `<div class="hint">sincronizado ${dt(p.last_synced_at)}</div>` : ''}</td>
        <td><div class="row" style="gap:.4em;justify-content:flex-end">${canEdit() ? `
          ${p.mode === 'live' && p.status === 'reauth' ? `<a class="btn small primary" href="/api/oauth/${p.network === 'tiktok' ? 'tiktok' : 'meta'}/start?brandId=${state.brandId}">Reconectar</a>` : ''}
          ${p.mode === 'live' && p.status !== 'reauth' ? `<button class="btn small" data-sync="${p.id}">Sincronizar</button>` : ''}
          <button class="btn small danger" data-del="${p.id}">Desconectar</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Nenhum perfil conectado.</p>'}
    </div>
    ${canEdit() ? `<div class="grid features" style="margin-bottom:1em">${LIVE_BUTTONS.map((b) => `
      <div class="card"><div class="row" style="gap:.4em;margin-bottom:.5em">${b.nets.map(netIcon).join('')}<h3 style="margin:0">${b.nets.map((n) => state.networks[n].label).join(' + ')}</h3></div>
        <p class="hint">${b.hint}</p>
        ${state.live[b.provider] ? `<a class="btn primary" href="/api/oauth/${b.provider}/start?brandId=${state.brandId}">${b.label}</a>`
          : '<p class="hint" style="color:var(--warning)">Integração ainda não configurada no servidor (veja o README).</p>'}
      </div>`).join('')}</div>
    <div class="card"><h3>Adicionar perfil de demonstração</h3>
      <form id="connect" class="row" style="align-items:end">
        <div style="flex:1;min-width:180px"><label>Rede</label><select name="network">${Object.entries(state.networks).map(([k, n]) => `<option value="${k}">${n.label}${liveNets.has(k) ? '' : ' (demonstração)'}</option>`).join('')}</select></div>
        <div style="flex:2;min-width:200px"><label>@ do perfil</label><input name="handle" placeholder="@suamarca" required></div>
        <button class="btn">Adicionar</button>
      </form><p class="error-msg"></p>
      <p class="hint">Perfis de demonstração não publicam de verdade: servem para testar o fluxo com métricas de exemplo.</p></div>` : ''}`;
  $('#connect')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await bapi('/profiles', { method: 'POST', body: { network: f.get('network'), handle: f.get('handle') } }); toast('Perfil adicionado'); renderProfiles(); }
    catch (err) { $('.error-msg', view()).textContent = err.message; }
  });
  view().querySelectorAll('[data-sync]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Sincronizando…';
    try { const r = await bapi(`/profiles/${b.dataset.sync}/sync`, { method: 'POST' }); toast(`Sincronizado · ${r.newComments} comentário(s) novo(s)`); }
    catch (err) { toast(err.message); }
    renderProfiles();
  }));
  view().querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Desconectar este perfil? As métricas dele serão removidas da Fmidia.')) return;
    await bapi(`/profiles/${b.dataset.del}`, { method: 'DELETE' }); toast('Perfil desconectado'); renderProfiles();
  }));
}

// Depois do login na Meta: o usuário escolhe quais Páginas/contas do Instagram conectar.
async function renderConnectPick(pendingId) {
  const p = await api(`/oauth/pending/${pendingId}`);
  if (p.brandId !== state.brandId) {
    state.brandId = p.brandId;
    $('#brand-select').value = p.brandId;
    $('#brand-dot').style.background = brand()?.color;
  }
  view().innerHTML = `
    <div class="page-head"><h1>Escolha as contas</h1></div>
    <form class="card" id="pick">
      <p class="muted">Encontramos estas contas no seu login. Marque as que serão gerenciadas em <strong>${esc(brand().name)}</strong>.</p>
      ${p.accounts.map((a) => `<label class="pick-row"><input type="checkbox" value="${a.index}" ${a.connected ? '' : 'checked'}>
        ${a.avatarUrl ? `<img src="${esc(a.avatarUrl)}" alt="" class="avatar-sm">` : netIcon(a.network)}
        <span><strong>${esc(a.handle)}</strong> <span class="hint">${esc(state.networks[a.network].label)}${a.pageName ? ` · Página ${esc(a.pageName)}` : ''} · ${num(a.followers)} seguidores</span>
        ${a.connected ? '<span class="badge published">já conectada</span>' : ''}</span></label>`).join('')}
      <p class="hint">Não apareceu um Instagram? Ele precisa ser conta profissional (Empresa ou Criador) vinculada a uma Página do Facebook, e você precisa ter acesso a essa Página.</p>
      <p class="error-msg"></p>
      <div class="row"><button class="btn primary">Conectar selecionadas</button><a class="btn" href="#/perfis">Cancelar</a></div>
    </form>`;
  $('#pick').onsubmit = async (e) => {
    e.preventDefault();
    const indexes = [...e.target.querySelectorAll('input:checked')].map((i) => Number(i.value));
    try {
      const r = await api(`/oauth/pending/${pendingId}`, { method: 'POST', body: { indexes } });
      toast(`${r.connected} conta(s) conectada(s). Buscando métricas…`);
      location.hash = '#/perfis';
    } catch (err) { $('.error-msg', view()).textContent = err.message; }
  };
}

/* ---------- Equipe e marca ---------- */
async function renderTeam() {
  const members = await bapi('/members');
  const owner = brand().role === 'owner';
  const ROLES = { owner: 'Proprietário', editor: 'Editor', viewer: 'Leitor' };
  view().innerHTML = `
    <div class="page-head"><h1>Equipe e marca</h1></div>
    <div class="card" style="margin-bottom:1em"><h3>Equipe</h3><div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th></th></tr></thead><tbody>
      ${members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${ROLES[m.role]}</td><td>${owner && m.id !== state.user.id ? `<button class="btn small danger" data-rm="${m.id}">Remover</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${owner ? `<form id="invite" class="row" style="align-items:end;margin-top:1em">
      <div style="flex:2;min-width:200px"><label>E-mail do usuário</label><input name="email" type="email" required></div>
      <div style="flex:1;min-width:140px"><label>Papel</label><select name="role"><option value="editor">Editor</option><option value="viewer">Leitor</option><option value="owner">Proprietário</option></select></div>
      <button class="btn primary">Adicionar</button></form><p class="error-msg" id="inv-err"></p>
      <p class="hint">Editores criam e agendam posts; leitores só visualizam; proprietários também gerenciam equipe e marca.</p>` : ''}</div>
    ${owner ? `<div class="card"><h3>Dados da marca</h3><form id="brand-form" class="row" style="align-items:end">
      <div style="flex:2;min-width:200px"><label>Nome</label><input name="name" value="${esc(brand().name)}" required></div>
      <div><label>Cor</label><input name="color" type="color" value="${brand().color}" style="height:42px;width:64px;padding:4px"></div>
      <button class="btn primary">Salvar</button><button type="button" class="btn danger" id="del-brand">Excluir marca</button></form></div>` : ''}`;
  $('#invite')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await bapi('/members', { method: 'POST', body: { email: f.get('email'), role: f.get('role') } }); toast('Membro adicionado'); renderTeam(); }
    catch (err) { $('#inv-err').textContent = err.message; }
  });
  view().querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    try { await bapi(`/members/${b.dataset.rm}`, { method: 'DELETE' }); renderTeam(); } catch (err) { toast(err.message); }
  }));
  $('#brand-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await bapi('', { method: 'PUT', body: { name: f.get('name'), color: f.get('color') } });
    toast('Marca atualizada'); await loadBrands(state.brandId); renderTeam();
  });
  $('#del-brand')?.addEventListener('click', async () => {
    if (!confirm(`Excluir "${brand().name}" com todos os posts, perfis e métricas? Esta ação não pode ser desfeita.`)) return;
    await bapi('', { method: 'DELETE' });
    try { localStorage.removeItem('fm_brand'); } catch {}
    await loadBrands(); location.hash = '#/dashboard'; route();
  });
}

init().catch((err) => { if (err.message !== '401') view().innerHTML = `<div class="card empty">${esc(err.message)}</div>`; });
