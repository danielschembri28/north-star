import { Router } from 'express';
import multer from 'multer';
import { one, query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { cleanUrl, clamp } from '../lib/util.js';
import { getTemplates, renderMessage } from '../lib/templates.js';
import { resumeHeld, tick } from '../lib/engine.js';
import { logEvent } from '../lib/events.js';
import { delayLabel } from '../lib/time.js';
import { providers } from '../config.js';
import { channelSummary } from './automation.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

export const STEPS = [
  ['Business', 'Tell us about your business', 'This is what customers see in every message. You can change it any time.'],
  ['Connect', 'Connect the app you already use', 'NorthStar watches for finished jobs and paid invoices, so you never have to send requests by hand.'],
  ['Customers', 'Bring in your customers', 'Choose where your customer list comes from.'],
  ['Trigger', 'When should we ask for a review?', 'Pick the moment that means the job is done.'],
  ['Timing', 'How long should we wait?', 'A short pause gives customers time to settle in before we ask.'],
  ['Messages', 'Choose how to reach customers', 'Pick one or more channels. We use the first one each customer can receive.'],
  ['Reminder', 'Add a friendly reminder', 'One follow-up, never more. Customers who opt out are never contacted again.'],
  ['Go live', 'Ready to collect reviews', 'Check your choices, then switch it on. Everything can be changed later.']
];

const DELAY_EXAMPLE = { 120: 'Monday at 12:00', 1440: 'Tuesday at 10:00', 4320: 'Thursday at 10:00' };

r.get('/onboarding', async (req, res) => {
  const b = req.business;
  const step = clamp(parseInt(req.query.step, 10) || Math.min(b.onboarding_step, 8), 1, 8);
  const [xero, customers, templates] = await Promise.all([
    one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'xero'", [b.id]),
    one('SELECT count(*)::int AS n, count(*) FILTER (WHERE phone <> \'\')::int AS phones FROM customers WHERE business_id = $1', [b.id]),
    getTemplates(b.id)
  ]);
  const firstMsg = renderMessage('whatsapp', templates.whatsapp.first, { customerName: '{first_name}', businessName: '{business_name}', service: '{service}', link: '' }).body.trim();
  const followMsg = renderMessage('whatsapp', templates.whatsapp.follow, { customerName: '{first_name}', businessName: '{business_name}', service: '{service}', link: '' }).body.trim();
  res.render('onboarding', {
    title: 'Set up NorthStar', step, steps: STEPS, xero, customers, firstMsg, followMsg,
    minutesLeft: Math.max(1, Math.round((9 - step) * 1.2)), delayExample: DELAY_EXAMPLE[b.delay_minutes] || 'after the wait you choose',
    xeroReady: providers.xeroReady(), channelText: channelSummary(b), delayText: delayLabel(b.delay_minutes), hideModeNotice: true
  });
});

async function advanceStep(b, n) {
  await query('UPDATE businesses SET onboarding_step = GREATEST(onboarding_step, $2) WHERE id = $1', [b.id, Math.min(8, n + 1)]);
}

r.post('/onboarding/:step', requireRole('manager'), upload.single('logo'), async (req, res) => {
  const b = req.business;
  const n = clamp(parseInt(req.params.step, 10) || 1, 1, 8);
  const next = () => res.redirect(`/onboarding?step=${Math.min(8, n + 1)}`);
  const body = req.body || {};
  if (body.nav === 'back') return res.redirect(`/onboarding?step=${Math.max(1, n - 1)}`);

  if (n === 1) {
    const name = String(body.name || '').trim() || b.name;
    const g = cleanUrl(body.google_review_url);
    const f = cleanUrl(body.facebook_review_url);
    let logoId = b.logo_file_id;
    if (req.file && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(req.file.mimetype)) {
      logoId = (await one('INSERT INTO files (business_id, mime, data) VALUES ($1,$2,$3) RETURNING id', [b.id, req.file.mimetype, req.file.buffer])).id;
      if (b.logo_file_id) await query('DELETE FROM files WHERE id = $1', [b.logo_file_id]);
    }
    if (body.google_review_url && !g) { req.flash('error', 'That Google link does not look right. Paste the full link from your Google Business Profile.'); return res.redirect('/onboarding?step=1'); }
    await query('UPDATE businesses SET name = $2, google_review_url = $3, facebook_review_url = $4, logo_file_id = $5 WHERE id = $1', [b.id, name, g, f, logoId]);
  } else if (n === 2) {
    const app = ['xero', 'webhook', 'csv', 'manual'].includes(body.app) ? body.app : 'manual';
    await query('UPDATE businesses SET trigger_source = $2 WHERE id = $1', [b.id, app]);
    await advanceStep(b, n);
    const xero = await one("SELECT 1 FROM integrations WHERE business_id = $1 AND provider = 'xero'", [b.id]);
    if (app === 'xero' && !xero) {
      if (!providers.xeroReady()) { req.flash('error', 'Xero is not set up on this server yet, so we skipped it. You can connect it later from Integrations.'); return next(); }
      return res.redirect('/integrations/xero/connect?return=' + encodeURIComponent('/onboarding?step=3'));
    }
    if (app === 'webhook') req.flash('info', `Your webhook address is ready on the Integrations page. Add it to Zapier or Make when you finish setup.`);
    return next();
  } else if (n === 4) {
    await query('UPDATE businesses SET trigger_type = $2 WHERE id = $1', [b.id, body.trigger === 'complete' ? 'complete' : 'paid']);
  } else if (n === 5) {
    let minutes = parseInt(body.delay, 10);
    if (body.delay === 'custom') minutes = clamp(Math.round((parseFloat(body.custom_hours) || 24) * 60), 0, 30 * 1440);
    if (Number.isNaN(minutes)) minutes = 1440;
    await query('UPDATE businesses SET delay_minutes = $2 WHERE id = $1', [b.id, minutes]);
  } else if (n === 6) {
    const on = (k) => body[k] === '1';
    if (!on('whatsapp') && !on('sms') && !on('email')) { req.flash('error', 'Pick at least one channel.'); return res.redirect('/onboarding?step=6'); }
    await query('UPDATE businesses SET channel_whatsapp = $2, channel_sms = $3, channel_email = $4 WHERE id = $1', [b.id, on('whatsapp'), on('sms'), on('email')]);
  } else if (n === 7) {
    await query('UPDATE businesses SET followup_enabled = $2, followup_wait_days = $3 WHERE id = $1', [b.id, body.follow === '1', clamp(parseInt(body.wait, 10) || 3, 1, 30)]);
  } else if (n === 8) {
    await query('UPDATE businesses SET automation_running = true, onboarding_done = true, onboarding_step = 8, paused_at = NULL, paused_by = NULL WHERE id = $1', [b.id]);
    const released = await resumeHeld(b.id);
    await logEvent(null, { business_id: b.id, type: 'system', text: `Automation turned on by ${req.user.name}`, meta: released ? `${released} waiting requests released` : 'Setup finished' });
    tick().catch(() => {});
    return res.redirect('/onboarding?step=8&live=1');
  }
  await advanceStep(b, n);
  next();
});

r.post('/onboarding-skip', async (req, res) => {
  await query('UPDATE businesses SET onboarding_step = GREATEST(onboarding_step, 2) WHERE id = $1', [req.business.id]);
  res.redirect('/dashboard?skip=1');
});


export default r;
