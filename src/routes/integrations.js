import { Router } from 'express';
import { many, one, query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { providers, config } from '../config.js';
import { xeroAuthUrl, completeXeroAuth, importXeroContacts, pollXero, disconnectXero } from '../lib/xero.js';
import { googleAuthUrl, completeGoogleAuth, syncGoogleReviews } from '../lib/google.js';
import { logEvent } from '../lib/events.js';

const r = Router();

export const ZAP_APPS = [
  { name: 'QuickBooks', kind: 'Accounting', detail: 'Send requests when an invoice is paid' },
  { name: 'Fresha', kind: 'Booking', detail: 'Send requests when an appointment is completed' },
  { name: 'Square Appointments', kind: 'Booking', detail: 'Send requests when an appointment is checked out' },
  { name: 'Jobber', kind: 'Booking', detail: 'Send requests when a job is marked complete' },
  { name: 'Zoho Invoice', kind: 'Accounting', detail: 'Send requests when an invoice is paid' },
  { name: 'HubSpot', kind: 'CRM', detail: 'Send requests when a deal moves to Won' },
  { name: 'Pipedrive', kind: 'CRM', detail: 'Send requests when a deal is closed' }
];

r.get('/integrations', async (req, res) => {
  const b = req.business;
  const filter = ['All', 'Accounting', 'Booking', 'CRM', 'Reviews'].includes(req.query.filter) ? req.query.filter : 'All';
  const rows = await many('SELECT * FROM integrations WHERE business_id = $1', [b.id]);
  const xero = rows.find((x) => x.provider === 'xero');
  const google = rows.find((x) => x.provider === 'google');
  const hooks = await one("SELECT count(*)::int AS n, max(created_at) AS last FROM jobs WHERE business_id = $1 AND source = 'webhook'", [b.id]);
  const status = (i) => (!i ? 'Not connected' : i.status === 'error' ? 'Error' : i.status === 'syncing' ? 'Syncing' : 'Connected');
  const apps = [
    { key: 'xero', name: 'Xero', kind: 'Accounting', status: status(xero), integ: xero, native: true, ready: providers.xeroReady(),
      detail: xero ? (xero.status === 'error' ? xero.error_message : xero.status === 'syncing' ? 'Importing your customer list for the first time' : `${xero.account_name || 'Organisation'} · last synced ${xero.last_sync_at ? res.locals.h.ago(xero.last_sync_at).toLowerCase() : 'just now'}`) : 'Send requests when an invoice is paid' },
    { key: 'google', name: 'Google Business Profile', kind: 'Reviews', status: status(google), integ: google, native: true, ready: providers.googleReady(),
      detail: google ? (google.status === 'error' ? google.error_message : `${google.account_name || 'Your profile'} · new reviews pulled in every 30 minutes`) : 'Pull in Google reviews, match them to customers and reply from here' },
    { key: 'webhook', name: 'Zapier, Make or your own app', kind: 'Any app', status: hooks.n ? 'Connected' : 'Not connected', native: true, ready: true,
      detail: hooks.n ? `${hooks.n} jobs received by webhook` : 'Send finished jobs from any app with a webhook' },
    ...ZAP_APPS.map((a) => ({ ...a, key: 'zap', status: 'Via Zapier', native: false, ready: true }))
  ];
  const shown = apps.filter((a) => filter === 'All' || a.kind === filter || (filter !== 'Reviews' && a.kind === 'Any app'));
  const errorInteg = rows.find((x) => x.status === 'error');
  res.render('integrations', { title: 'Integrations', active: 'integrations', apps: shown, filter, xero, google, errorInteg, hooks, supportEmail: process.env.SUPPORT_EMAIL || '' });
});

function needsSetup(req, res, name) {
  req.flash('error', `${name} is not set up on this server yet. Add the ${name === 'Xero' ? 'XERO_CLIENT_ID and XERO_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'} settings (see the README), then try again.`);
  res.redirect('/integrations');
}

r.get('/integrations/xero/connect', requireRole('manager'), async (req, res) => {
  if (!providers.xeroReady()) return needsSetup(req, res, 'Xero');
  res.redirect(await xeroAuthUrl(req.business, req.user, String(req.query.return || '/integrations')));
});

r.get('/integrations/xero/callback', async (req, res) => {
  const state = await one("DELETE FROM oauth_states WHERE state = $1 AND provider = 'xero' AND created_at > now() - interval '1 hour' RETURNING *", [String(req.query.state || '')]);
  if (!state || state.business_id !== req.business.id) { req.flash('error', 'That Xero sign-in expired. Please try connecting again.'); return res.redirect('/integrations'); }
  if (req.query.error || !req.query.code) { req.flash('error', 'Xero was not connected.'); return res.redirect(state.return_to || '/integrations'); }
  try {
    await completeXeroAuth(String(req.query.code), state);
    req.flash('success', 'Xero is connected. Your customer list is importing in the background.');
  } catch (e) {
    req.flash('error', `Xero could not be connected: ${e.message}`);
  }
  res.redirect(state.return_to || '/integrations');
});

r.post('/integrations/xero/sync', requireRole('manager'), async (req, res) => {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'xero'", [req.business.id]);
  if (!integ) return res.redirect('/integrations');
  try {
    await pollXero(integ);
    importXeroContacts(req.business.id).catch(() => {});
    req.flash('success', 'Xero synced. New paid invoices will start review requests.');
  } catch (e) {
    req.flash('error', `Sync failed: ${e.message}`);
  }
  res.redirect('/integrations');
});

r.post('/integrations/xero/disconnect', requireRole('manager'), async (req, res) => {
  await disconnectXero(req.business.id);
  req.flash('success', 'Xero was disconnected. Customers already imported stay in NorthStar.');
  res.redirect('/integrations');
});

r.get('/integrations/google/connect', requireRole('manager'), async (req, res) => {
  if (!providers.googleReady()) return needsSetup(req, res, 'Google');
  res.redirect(await googleAuthUrl(req.business, req.user));
});

r.get('/integrations/google/callback', async (req, res) => {
  const state = await one("DELETE FROM oauth_states WHERE state = $1 AND provider = 'google' AND created_at > now() - interval '1 hour' RETURNING *", [String(req.query.state || '')]);
  if (!state || state.business_id !== req.business.id) { req.flash('error', 'That Google sign-in expired. Please try again.'); return res.redirect('/integrations'); }
  if (req.query.error || !req.query.code) { req.flash('error', 'Google was not connected.'); return res.redirect('/integrations'); }
  try {
    await completeGoogleAuth(String(req.query.code), state);
    req.flash('success', 'Google Business Profile is connected. Your reviews are being pulled in.');
  } catch (e) {
    req.flash('error', `Google could not be connected: ${e.message}`);
  }
  res.redirect('/integrations');
});

r.post('/integrations/google/sync', requireRole('manager'), async (req, res) => {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'google'", [req.business.id]);
  if (integ) {
    try { const n = await syncGoogleReviews(integ); req.flash('success', `Google synced. ${n} new reviews.`); } catch (e) { req.flash('error', `Sync failed: ${e.message}`); }
  }
  res.redirect('/integrations');
});

r.post('/integrations/google/disconnect', requireRole('manager'), async (req, res) => {
  await query("DELETE FROM integrations WHERE business_id = $1 AND provider = 'google'", [req.business.id]);
  await logEvent(null, { business_id: req.business.id, type: 'integration', text: 'Disconnected Google Business Profile' });
  req.flash('success', 'Google was disconnected. Reviews already pulled in stay in NorthStar.');
  res.redirect('/integrations');
});

r.get('/integrations/webhook', async (req, res) => {
  const app = ZAP_APPS.find((a) => a.name === req.query.app) || null;
  res.render('webhook', { title: 'Connect by webhook', active: 'integrations', url: `${config.baseUrl}/webhooks/inbound/${req.business.webhook_key}`, app });
});

r.post('/integrations/webhook/rotate', requireRole('owner'), async (req, res) => {
  await query("UPDATE businesses SET webhook_key = replace(gen_random_uuid()::text, '-', '') WHERE id = $1", [req.business.id]);
  req.flash('success', 'A new webhook address was created. Update it in Zapier or Make; the old one no longer works.');
  res.redirect('/integrations/webhook');
});

export default r;
