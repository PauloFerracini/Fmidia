const { config } = require('../config');

// Erro de uma API externa. `auth` indica token inválido/expirado (precisa reconectar).
class IntegrationError extends Error {
  constructor(message, { status, code, auth = false, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.auth = auth;
    this.details = details;
  }
}

async function request(url, { method = 'GET', query, form, json, headers = {} } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
  let body;
  if (form) {
    body = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers };
  } else if (json) {
    body = JSON.stringify(json);
    headers = { 'Content-Type': 'application/json; charset=UTF-8', ...headers };
  }
  let res;
  try {
    res = await fetch(u, { method, body, headers, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new IntegrationError(`Falha de rede ao chamar ${u.hostname}: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Repete check() até retornar algo diferente de undefined ou estourar o tempo limite.
async function poll(check, what) {
  const deadline = Date.now() + config.publishTimeoutMs();
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new IntegrationError(`Tempo esgotado aguardando ${what}`);
    await sleep(config.pollMs());
  }
}

module.exports = { request, poll, sleep, IntegrationError };
