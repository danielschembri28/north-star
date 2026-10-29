import { one, query } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256, safeEqual } from './crypto.js';

const COOKIE = 'ns_session';
const SESSION_DAYS = 30;

export const ROLE_RANK = { viewer: 1, manager: 2, owner: 3 };
export const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', viewer: 'View only' };

export async function createSession(res, userId, businessId = null) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await query('INSERT INTO sessions (id, user_id, business_id, csrf, expires_at) VALUES ($1,$2,$3,$4,$5)', [sha256(token), userId, businessId, csrf, expires]);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://'), expires, path: '/'
  });
}

export async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

// Attaches req.session, req.user, req.business, req.role when signed in.
export async function loadSession(req, res, next) {
  req.flash = (type, message) => {
    req._flash = [...(req._flash || []), { type, message }];
  };
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  const s = await one('SELECT * FROM sessions WHERE id = $1 AND expires_at > now()', [sha256(token)]);
  if (!s) { res.clearCookie(COOKIE, { path: '/' }); return next(); }
  const user = await one('SELECT id, email, name, created_at FROM users WHERE id = $1', [s.user_id]);
  if (!user) return next();
  req.session = s;
  req.user = user;
  let m = null;
  if (s.business_id) {
    m = await one('SELECT b.*, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 AND m.business_id = $2', [user.id, s.business_id]);
  }
  if (!m) {
    m = await one('SELECT b.*, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 ORDER BY m.created_at LIMIT 1', [user.id]);
    if (m) await query('UPDATE sessions SET business_id = $1 WHERE id = $2', [m.id, s.id]);
  }
  if (m) {
    const { role, ...business } = m;
    req.business = business;
    req.role = role;
  }
  // Flash messages saved by the previous request.
  req.incomingFlash = s.flash || [];
  if (s.flash) await query('UPDATE sessions SET flash = NULL WHERE id = $1', [s.id]);
  // Persist new flash messages when a redirect happens.
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req._flash?.length) {
      query('UPDATE sessions SET flash = $1 WHERE id = $2', [JSON.stringify(req._flash), s.id])
        .then(() => redirect(...args))
        .catch(next);
    } else redirect(...args);
  };
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect('/login' + nextUrl);
  }
  if (!req.business && !req.path.startsWith('/businesses')) return res.redirect('/businesses/new');
  next();
}

export function can(req, level) {
  return (ROLE_RANK[req.role] || 0) >= ROLE_RANK[level];
}

export const requireRole = (level) => (req, res, next) => {
  if (can(req, level)) return next();
  const msg = level === 'owner' ? 'Only the business owner can do that.' : 'Your account is view only. Ask the owner for manager access to make changes.';
  if (req.accepts(['html', 'json']) === 'json') return res.status(403).json({ error: msg });
  req.flash('error', msg);
  res.redirect(req.get('Referer') || '/dashboard');
};

export function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next();
  // Multipart forms (file uploads) carry the token in the query string.
  const sent = req.body?._csrf || req.get('x-csrf-token') || req.query?._csrf || '';
  if (sent && safeEqual(sent, req.session.csrf)) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'This form expired. Go back, refresh the page and try again.' });
}
