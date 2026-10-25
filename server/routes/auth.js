const express = require('express');
const { hashPassword, verifyPassword, createSession, requireAuth } = require('../auth');
const { config } = require('../config');

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5, secure: config.publicUrl().startsWith('https://') });

module.exports = function authRoutes(db) {
  const r = express.Router();

  r.post('/register', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Preencha nome, e-mail e senha' });
    if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres' });
    const normalized = String(email).trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(String(name).trim(), normalized, hashPassword(password));
    res.cookie('fm_session', createSession(db, Number(lastInsertRowid)), cookieOpts());
    res.status(201).json({ id: Number(lastInsertRowid), name, email: normalized });
  });

  r.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
    if (!user || !password || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    }
    res.cookie('fm_session', createSession(db, user.id), cookieOpts());
    res.json({ id: user.id, name: user.name, email: user.email });
  });

  r.post('/logout', (req, res) => {
    if (req.cookies?.fm_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.fm_session);
    res.clearCookie('fm_session');
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(db), (req, res) => res.json(req.user));

  return r;
};
