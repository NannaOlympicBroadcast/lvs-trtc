'use strict';
// 双通道认证：JWT (Authorization: Bearer xx) 或 API Key (X-API-Key / Bearer lvs_xx)
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/pool');

async function loadUser(id) {
  const { rows } = await db.query(
    'SELECT id, username, nickname, email, role, bio, banned_until, ban_reason, created_at FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function resolveAuth(req) {
  const apiKeyHeader = req.headers['x-api-key'];
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const token = apiKeyHeader || bearer || req.query.token;

  if (!token) return null;
  if (token.startsWith('lvs_')) {
    const { rows } = await db.query('SELECT user_id FROM api_keys WHERE token = $1', [token]);
    if (!rows[0]) return null;
    db.query('UPDATE api_keys SET last_used_at = now() WHERE token = $1', [token]).catch(() => {});
    return loadUser(rows[0].user_id);
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return loadUser(payload.uid);
  } catch {
    return null;
  }
}

function isBanned(user) {
  return user.banned_until && new Date(user.banned_until) > new Date();
}

// 可选认证：有凭证则挂 req.user
async function optionalAuth(req, _res, next) {
  try { req.user = await resolveAuth(req); } catch { req.user = null; }
  next();
}

async function requireAuth(req, res, next) {
  try {
    const user = await resolveAuth(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (isBanned(user)) {
      return res.status(403).json({ error: 'banned', banned_until: user.banned_until, reason: user.ban_reason });
    }
    req.user = user;
    next();
  } catch (e) { next(e); }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

module.exports = { optionalAuth, requireAuth, requireAdmin, signToken, resolveAuth, isBanned };
