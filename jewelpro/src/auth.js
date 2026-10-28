'use strict';
const crypto = require('node:crypto');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'jp_session';
const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const ALL_PERMISSIONS = [
  'users.manage',
  'settings.view', 'settings.manage',
  'rates.view', 'rates.update',
  'products.view', 'products.manage',
  'customers.view', 'customers.manage',
  'sales.view', 'sales.create', 'sales.cancel', 'sales.discount_over_limit',
  'reports.view',
  'backup.run',
  'audit.view',
  'purchases.manage', 'karigars.manage', 'orders.manage', 'repairs.manage', 'metal.manage',
  'payments.make', 'expenses.create', 'accounts.view', 'accounts.manage',
  'categories.manage', 'products.remove', 'purchases.cancel', 'costs.view', 'stock.private', 'stockreg.view'
];

/*
 * Owner: everything.
 * Staff: dashboard, gold rates, inventory (add and edit items, add and rename categories), invoices (bill and
 * take payments), purchases and suppliers, customers. Staff never see owner-only stock, cost prices, profit,
 * supplier balances, accounts, reports, settings, staff logins or the audit log, and cannot cancel or remove.
 */
const ROLE_PERMISSIONS = {
  owner: ALL_PERMISSIONS,
  staff: ['rates.view', 'rates.update', 'products.view', 'products.manage', 'categories.manage',
    'customers.view', 'customers.manage', 'sales.view', 'sales.create', 'purchases.manage']
};
const ROLES = Object.keys(ROLE_PERMISSIONS);

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function can(user, permission) {
  return !!user && permissionsFor(user.role).includes(permission);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

/** Returns a message describing what is wrong with the password, or null if it is acceptable. */
function passwordProblem(password, username) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain at least one letter and one number.';
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  return null;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
  store.run('DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  store.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    hashToken(token), userId, now.toISOString(), expires.toISOString()
  );
  return { token, expires };
}

function setSessionCookie(res, token, expires) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', expires, path: '/' });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
}

/** Attaches req.user when a valid session cookie is present. */
function authenticate(store) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.sessionToken = token || null;
    req.user = null;
    if (token) {
      const row = store.get(
        `SELECT u.id, u.username, u.full_name, u.role, u.must_change_password, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
        hashToken(token), new Date().toISOString()
      );
      if (row && row.is_active) req.user = row;
    }
    next();
  };
}

function requireLogin(req, _res, next) {
  if (!req.user) return next(unauthorized('Please log in.'));
  if (req.user.must_change_password) return next(forbidden('Change your password before continuing.'));
  next();
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (!can(req.user, permission)) return next(forbidden('You do not have permission to do this.'));
    next();
  };
}

/** Simple in-memory limit on login attempts per IP address. */
function loginRateLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      return res.status(429).json({ error: 'Too many login attempts. Wait a minute and try again.' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

module.exports = {
  ROLES,
  SESSION_COOKIE, MAX_FAILED_LOGINS, LOCKOUT_MINUTES, ALL_PERMISSIONS,
  permissionsFor, can, hashPassword, verifyPassword, passwordProblem,
  createSession, setSessionCookie, clearSessionCookie, hashToken,
  authenticate, requireLogin, requirePermission, loginRateLimiter
};
