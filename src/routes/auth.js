import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, query, tx } from '../db.js';
import { config } from '../config.js';
import { createSession, destroySession, verifyCsrf } from '../lib/auth.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.js';
import { isEmail } from '../lib/util.js';
import { sendEmail, reviewEmailHtml } from '../lib/providers.js';

const r = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: () => !config.isProd });

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

export async function createBusiness(db, { name, userId, timezone }) {
  const b = (await db.query(
    'INSERT INTO businesses (name, timezone, monthly_message_limit) VALUES ($1, $2, $3) RETURNING *',
    [name, timezone || config.defaultTimezone, config.defaultMonthlyMessages]
  )).rows[0];
  await db.query("INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')", [userId, b.id]);
  await db.query("INSERT INTO events (business_id, type, text) VALUES ($1, 'system', 'Business created')", [b.id]);
  return b;
}

r.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));

r.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  if (!config.signupsOpen) return res.render('auth/closed', { title: 'Sign up' });
  res.render('auth/signup', { title: 'Create your account', values: {}, error: null });
});

r.post('/signup', limiter, async (req, res) => {
  if (!config.signupsOpen) return res.redirect('/login');
  const values = { name: String(req.body.name || '').trim(), email: String(req.body.email || '').trim().toLowerCase(), business: String(req.body.business || '').trim() };
  const password = String(req.body.password || '');
  let error = null;
  if (!values.name || !values.business) error = 'Please fill in your name and your business name.';
  else if (!isEmail(values.email)) error = 'Please enter a valid email address.';
  else if (password.length < 10) error = 'Use a password of at least 10 characters.';
  else if (await one('SELECT 1 FROM users WHERE email = $1', [values.email])) error = 'An account with that email already exists. Try signing in instead.';
  if (error) return res.status(400).render('auth/signup', { title: 'Create your account', values, error });

  const hash = await hashPassword(password);
  const { user, business } = await tx(async (db) => {
    const user = (await db.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [values.email, values.name, hash])).rows[0];
    const business = await createBusiness(db, { name: values.business, userId: user.id });
    return { user, business };
  });
  await createSession(res, user.id, business.id);
  res.redirect('/onboarding');
});

r.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('auth/login', { title: 'Sign in', email: '', error: null, next: req.query.next || '', signupsOpen: config.signupsOpen });
});

r.post('/login', limiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await one('SELECT * FROM users WHERE email = $1', [email]);
  const ok = user && (await verifyPassword(String(req.body.password || ''), user.password_hash));
  if (!ok) {
    return res.status(401).render('auth/login', { title: 'Sign in', email, error: 'That email and password do not match.', next: req.body.next || '', signupsOpen: config.signupsOpen });
  }
  if (req.cookies?.ns_session) await destroySession(req, res);
  await createSession(res, user.id);
  res.redirect(safeNext(req.body.next));
});

r.post('/logout', verifyCsrf, async (req, res) => {
  await destroySession(req, res);
  res.redirect('/login');
});

r.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Reset your password', sent: false }));

r.post('/forgot', limiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await one('SELECT * FROM users WHERE email = $1', [email]);
  if (user) {
    const token = randomToken(32);
    await query("UPDATE users SET reset_token_hash = $2, reset_expires_at = now() + interval '1 hour' WHERE id = $1", [user.id, sha256(token)]);
    const link = `${config.baseUrl}/reset/${token}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your NorthStar password',
      text: `Hi ${user.name},\n\nUse this link to choose a new password. It works for one hour.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      html: reviewEmailHtml({ businessName: 'NorthStar', body: `Hi ${user.name},\n\nUse the button below to choose a new password. It works for one hour.\n\nIf you did not ask for this, you can ignore this email.`, link, buttonLabel: 'Choose a new password' })
    }).catch((e) => console.error('reset email failed', e.message));
  }
  res.render('auth/forgot', { title: 'Reset your password', sent: true });
});

r.get('/reset/:token', async (req, res) => {
  const user = await one('SELECT id FROM users WHERE reset_token_hash = $1 AND reset_expires_at > now()', [sha256(req.params.token)]);
  if (!user) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link has expired or was already used. Ask for a new one.' });
  res.render('auth/reset', { title: 'Choose a new password', token: req.params.token, error: null });
});

r.post('/reset/:token', limiter, async (req, res) => {
  const user = await one('SELECT id FROM users WHERE reset_token_hash = $1 AND reset_expires_at > now()', [sha256(req.params.token)]);
  if (!user) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link has expired or was already used. Ask for a new one.' });
  const password = String(req.body.password || '');
  if (password.length < 10) return res.status(400).render('auth/reset', { title: 'Choose a new password', token: req.params.token, error: 'Use a password of at least 10 characters.' });
  await query('UPDATE users SET password_hash = $2, reset_token_hash = NULL, reset_expires_at = NULL WHERE id = $1', [user.id, await hashPassword(password)]);
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await createSession(res, user.id);
  res.redirect('/dashboard');
});

// Team invites
async function findInvite(token) {
  return one(
    `SELECT i.*, b.name AS business_name FROM invites i JOIN businesses b ON b.id = i.business_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.created_at > now() - interval '14 days'`,
    [sha256(token)]
  );
}

r.get('/invite/:token', async (req, res) => {
  const invite = await findInvite(req.params.token);
  if (!invite) return res.status(400).render('error', { title: 'Invite not valid', message: 'This invite has expired or was already used. Ask the owner to send a new one.' });
  const existing = await one('SELECT id FROM users WHERE email = $1', [invite.email]);
  res.render('auth/invite', { title: 'Join ' + invite.business_name, invite, token: req.params.token, existing: !!existing, error: null });
});

r.post('/invite/:token', limiter, async (req, res) => {
  const invite = await findInvite(req.params.token);
  if (!invite) return res.status(400).render('error', { title: 'Invite not valid', message: 'This invite has expired or was already used.' });
  let user = await one('SELECT * FROM users WHERE email = $1', [invite.email]);
  if (user) {
    const ok = await verifyPassword(String(req.body.password || ''), user.password_hash);
    if (!ok) return res.status(401).render('auth/invite', { title: 'Join ' + invite.business_name, invite, token: req.params.token, existing: true, error: 'That password is not right.' });
  } else {
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    if (!name || password.length < 10) {
      return res.status(400).render('auth/invite', { title: 'Join ' + invite.business_name, invite, token: req.params.token, existing: false, error: 'Add your name and a password of at least 10 characters.' });
    }
    user = await one('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [invite.email, name, await hashPassword(password)]);
  }
  await query('INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, business_id) DO UPDATE SET role = EXCLUDED.role', [user.id, invite.business_id, invite.role]);
  await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
  if (req.cookies?.ns_session) await destroySession(req, res);
  await createSession(res, user.id, invite.business_id);
  res.redirect('/dashboard');
});

// Businesses: one login can run several (handy for agencies).
r.get('/businesses', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const list = await query('SELECT b.id, b.name, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 ORDER BY b.name', [req.user.id]);
  res.render('auth/businesses', { title: 'Your businesses', list: list.rows });
});

r.get('/businesses/new', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('auth/business-new', { title: 'Add a business', error: null });
});

r.post('/businesses', verifyCsrf, async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).render('auth/business-new', { title: 'Add a business', error: 'Give the business a name.' });
  const b = await tx((db) => createBusiness(db, { name, userId: req.user.id, timezone: req.business?.timezone }));
  await query('UPDATE sessions SET business_id = $1 WHERE id = $2', [b.id, req.session.id]);
  res.redirect('/onboarding');
});

r.post('/businesses/:id/switch', verifyCsrf, async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const m = await one('SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2', [req.user.id, req.params.id]);
  if (m) await query('UPDATE sessions SET business_id = $1 WHERE id = $2', [req.params.id, req.session.id]);
  res.redirect('/dashboard');
});

export default r;
