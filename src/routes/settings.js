import { Router } from 'express';
import multer from 'multer';
import { many, one, query } from '../db.js';
import { requireRole, ROLE_LABEL } from '../lib/auth.js';
import { cleanUrl, clamp } from '../lib/util.js';
import { randomToken, sha256, hashPassword, verifyPassword } from '../lib/crypto.js';
import { sendEmail, reviewEmailHtml } from '../lib/providers.js';
import { startOfLocalMonth, TIMEZONES } from '../lib/time.js';
import { config, providers } from '../config.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

r.get('/settings', async (req, res) => {
  const b = req.business;
  const [team, invites, optouts, usage] = await Promise.all([
    many('SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY m.created_at', [b.id]),
    many('SELECT * FROM invites WHERE business_id = $1 AND accepted_at IS NULL AND created_at > now() - interval \'14 days\' ORDER BY created_at DESC', [b.id]),
    one('SELECT count(*)::int AS n FROM customers WHERE business_id = $1 AND opted_out', [b.id]),
    one('SELECT count(*)::int AS n FROM review_requests WHERE business_id = $1 AND sent_at >= $2', [b.id, startOfLocalMonth(new Date(), b.timezone)])
  ]);
  res.render('settings', {
    title: 'Settings', active: 'settings', team, invites, optouts: optouts.n, usage: usage.n, ROLE_LABEL, TIMEZONES,
    stripeReady: providers.stripeReady(), plan: config.stripe, billingNote: req.query.billing
  });
});

r.post('/settings/profile', requireRole('manager'), upload.single('logo'), async (req, res) => {
  const b = req.business;
  const name = String(req.body.name || '').trim();
  if (!name) { req.flash('error', 'The business name cannot be empty.'); return res.redirect('/settings#profile'); }
  let logoId = b.logo_file_id;
  if (req.file) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(req.file.mimetype)) {
      req.flash('error', 'Upload the logo as a PNG, JPG, WebP or GIF image.');
      return res.redirect('/settings#profile');
    }
    const f = await one('INSERT INTO files (business_id, mime, data) VALUES ($1,$2,$3) RETURNING id', [b.id, req.file.mimetype, req.file.buffer]);
    if (b.logo_file_id) await query('DELETE FROM files WHERE id = $1', [b.logo_file_id]);
    logoId = f.id;
  } else if (req.body.remove_logo === '1' && b.logo_file_id) {
    await query('DELETE FROM files WHERE id = $1', [b.logo_file_id]);
    logoId = null;
  }
  await query('UPDATE businesses SET name = $2, phone = $3, logo_file_id = $4 WHERE id = $1', [b.id, name.slice(0, 120), String(req.body.phone || '').trim().slice(0, 40), logoId]);
  req.flash('success', 'Business profile saved.');
  res.redirect(req.query.back === 'onboarding' ? '/onboarding?step=2' : '/settings#profile');
});

r.post('/settings/links', requireRole('manager'), async (req, res) => {
  const g = cleanUrl(req.body.google_review_url);
  const f = cleanUrl(req.body.facebook_review_url);
  if ((req.body.google_review_url && !g) || (req.body.facebook_review_url && !f)) {
    req.flash('error', 'One of those links does not look like a web address. Paste the full link, starting with https://');
    return res.redirect('/settings#links');
  }
  await query('UPDATE businesses SET google_review_url = $2, facebook_review_url = $3 WHERE id = $1', [req.business.id, g, f]);
  req.flash('success', 'Review links saved.');
  res.redirect('/settings#links');
});

r.post('/settings/sending', requireRole('manager'), async (req, res) => {
  const qs = HHMM.test(req.body.quiet_start) ? req.body.quiet_start : '20:00';
  const qe = HHMM.test(req.body.quiet_end) ? req.body.quiet_end : '08:00';
  const tz = TIMEZONES.includes(req.body.timezone) ? req.body.timezone : req.business.timezone;
  const limit = clamp(parseInt(req.body.daily_limit, 10) || 50, 1, 5000);
  const repeat = req.body.repeat_guard === '1' ? clamp(parseInt(req.body.repeat_guard_days, 10) || 90, 7, 730) : 0;
  await query(
    'UPDATE businesses SET daily_limit = $2, quiet_start = $3, quiet_end = $4, timezone = $5, skip_sundays = $6, repeat_guard_days = $7 WHERE id = $1',
    [req.business.id, limit, qs, qe, tz, req.body.skip_sundays === '1', repeat]
  );
  req.flash('success', 'Sending rules saved.');
  res.redirect('/settings#sending');
});

r.post('/settings/team/invite', requireRole('owner'), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = ['manager', 'viewer', 'owner'].includes(req.body.role) ? req.body.role : 'viewer';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { req.flash('error', 'Enter a valid email address.'); return res.redirect('/settings#team'); }
  const member = await one('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 AND u.email = $2', [req.business.id, email]);
  if (member) { req.flash('error', 'That person is already on the team.'); return res.redirect('/settings#team'); }
  const token = randomToken(32);
  await query('INSERT INTO invites (business_id, email, role, token_hash, invited_by) VALUES ($1,$2,$3,$4,$5)', [req.business.id, email, role, sha256(token), req.user.id]);
  const link = `${config.baseUrl}/invite/${token}`;
  try {
    await sendEmail({
      to: email,
      subject: `${req.user.name} invited you to ${req.business.name} on NorthStar`,
      text: `${req.user.name} invited you to help manage reviews for ${req.business.name}.\n\nAccept the invite: ${link}\n\nThe link works for 14 days.`,
      html: reviewEmailHtml({ businessName: req.business.name, body: `${req.user.name} invited you to help manage reviews for ${req.business.name} on NorthStar.\n\nThe link works for 14 days.`, link, buttonLabel: 'Accept invite' })
    });
    req.flash('success', `Invite sent to ${email}.`);
  } catch (e) {
    req.flash('info', `The email could not be sent (${e.message}). Share this link with them instead: ${link}`);
  }
  if (config.messageMode === 'console') req.flash('info', `Test mode: share this invite link directly: ${link}`);
  res.redirect('/settings#team');
});

r.post('/settings/invites/:id/cancel', requireRole('owner'), async (req, res) => {
  await query('DELETE FROM invites WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
  res.redirect('/settings#team');
});

async function ownerCount(businessId) {
  return (await one("SELECT count(*)::int AS n FROM memberships WHERE business_id = $1 AND role = 'owner'", [businessId])).n;
}

r.post('/settings/team/:userId/role', requireRole('owner'), async (req, res) => {
  const role = ['manager', 'viewer', 'owner'].includes(req.body.role) ? req.body.role : null;
  const m = await one('SELECT * FROM memberships WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
  if (!role || !m) return res.redirect('/settings#team');
  if (m.role === 'owner' && role !== 'owner' && (await ownerCount(req.business.id)) < 2) {
    req.flash('error', 'A business needs at least one owner. Make someone else an owner first.');
    return res.redirect('/settings#team');
  }
  await query('UPDATE memberships SET role = $3 WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId, role]);
  req.flash('success', 'Role updated.');
  res.redirect('/settings#team');
});

r.post('/settings/team/:userId/remove', requireRole('owner'), async (req, res) => {
  const m = await one('SELECT * FROM memberships WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
  if (!m) return res.redirect('/settings#team');
  if (m.role === 'owner' && (await ownerCount(req.business.id)) < 2) {
    req.flash('error', 'You cannot remove the only owner.');
    return res.redirect('/settings#team');
  }
  await query('DELETE FROM memberships WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
  await query('UPDATE sessions SET business_id = NULL WHERE user_id = $1 AND business_id = $2', [req.params.userId, req.business.id]);
  req.flash('success', 'Removed from the team.');
  res.redirect('/settings#team');
});

r.post('/settings/account', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) await query('UPDATE users SET name = $2 WHERE id = $1', [req.user.id, name.slice(0, 120)]);
  if (req.body.new_password) {
    const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(String(req.body.current_password || ''), u.password_hash))) { req.flash('error', 'Your current password is not right.'); return res.redirect('/settings#account'); }
    if (String(req.body.new_password).length < 10) { req.flash('error', 'Use a new password of at least 10 characters.'); return res.redirect('/settings#account'); }
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(String(req.body.new_password))]);
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.session.id]);
  }
  req.flash('success', 'Your account was updated.');
  res.redirect('/settings#account');
});

r.post('/settings/delete-business', requireRole('owner'), async (req, res) => {
  if (String(req.body.confirm || '').trim() !== req.business.name) {
    req.flash('error', 'Type the business name exactly to confirm.');
    return res.redirect('/settings#danger');
  }
  await query('DELETE FROM businesses WHERE id = $1', [req.business.id]);
  await query('UPDATE sessions SET business_id = NULL WHERE id = $1', [req.session.id]);
  res.redirect('/businesses');
});

export default r;
