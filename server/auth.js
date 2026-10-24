const crypto = require('node:crypto');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

// Middleware: carrega req.user a partir do cookie de sessão; responde 401 se ausente.
function requireAuth(db) {
  return (req, res, next) => {
    const token = req.cookies?.fm_session;
    const row = token && db.prepare(
      `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    ).get(token, new Date().toISOString());
    if (!row) return res.status(401).json({ error: 'Não autenticado' });
    req.user = { ...row };
    next();
  };
}

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };

// Middleware: garante que o usuário pertence à marca :brandId com papel mínimo.
function requireBrand(db, minRole = 'viewer') {
  return (req, res, next) => {
    const brandId = Number(req.params.brandId);
    const m = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND brand_id = ?').get(req.user.id, brandId);
    if (!m) return res.status(404).json({ error: 'Marca não encontrada' });
    if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) return res.status(403).json({ error: 'Permissão insuficiente' });
    req.brandId = brandId;
    req.role = m.role;
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createSession, requireAuth, requireBrand };
