// Xero: OAuth 2.0 connection, paid-invoice webhooks, polling fallback and
// first-time contact import. Docs: https://developer.xero.com/documentation/
import { many, one, query } from '../db.js';
import { config, providers } from '../config.js';
import { encrypt, decrypt, hmac, randomToken, safeEqual } from './crypto.js';
import { ingestJob, upsertCustomer } from './ingest.js';
import { logEvent } from './events.js';

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API = 'https://api.xero.com/api.xro/2.0';
const redirectUri = () => `${config.baseUrl}/integrations/xero/callback`;

export async function xeroAuthUrl(business, user, returnTo = '/integrations') {
  const state = randomToken(24);
  await query('INSERT INTO oauth_states (state, business_id, user_id, provider, return_to) VALUES ($1,$2,$3,$4,$5)', [state, business.id, user.id, 'xero', returnTo]);
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({ response_type: 'code', client_id: config.xero.clientId, redirect_uri: redirectUri(), scope: config.xero.scopes, state }).toString();
  return u.toString();
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Xero token error ${res.status}`);
  return data;
}

export async function completeXeroAuth(code, stateRow) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const conns = await (await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json();
  const tenant = Array.isArray(conns) ? conns.find((c) => c.tenantType === 'ORGANISATION') || conns[0] : null;
  if (!tenant) throw new Error('No Xero organisation was shared with NorthStar.');
  await query(
    `INSERT INTO integrations (business_id, provider, status, access_token, refresh_token, expires_at, tenant_id, account_name, error_message, error_at, last_sync_at)
     VALUES ($1,'xero','syncing',$2,$3,$4,$5,$6,NULL,NULL,NULL)
     ON CONFLICT (business_id, provider) DO UPDATE SET status = 'syncing', access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at, tenant_id = EXCLUDED.tenant_id, account_name = EXCLUDED.account_name, error_message = NULL, error_at = NULL`,
    [stateRow.business_id, encrypt(tokens.access_token), encrypt(tokens.refresh_token), new Date(Date.now() + (tokens.expires_in - 60) * 1000), tenant.tenantId, tenant.tenantName]
  );
  await query("UPDATE businesses SET trigger_source = 'xero' WHERE id = $1", [stateRow.business_id]);
  await logEvent(null, { business_id: stateRow.business_id, type: 'integration', text: `Connected Xero (${tenant.tenantName})` });
  // Import contacts in the background so the user isn't kept waiting.
  importXeroContacts(stateRow.business_id).catch((e) => console.error('xero import failed', e));
}

async function markError(integ, message) {
  await query("UPDATE integrations SET status = 'error', error_message = $2, error_at = now() WHERE id = $1", [integ.id, message]);
  await logEvent(null, { business_id: integ.business_id, type: 'integration', text: `Xero stopped syncing`, meta: message });
}

async function accessToken(integ) {
  if (integ.expires_at && new Date(integ.expires_at) > new Date()) return decrypt(integ.access_token);
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(integ.refresh_token) });
    await query('UPDATE integrations SET access_token = $2, refresh_token = $3, expires_at = $4 WHERE id = $1',
      [integ.id, encrypt(t.access_token), encrypt(t.refresh_token), new Date(Date.now() + (t.expires_in - 60) * 1000)]);
    return t.access_token;
  } catch (e) {
    await markError(integ, 'Its sign-in expired, so new invoices are not triggering requests. Reconnect to fix it.');
    throw e;
  }
}

async function xeroGet(integ, path, { modifiedSince } = {}) {
  const token = await accessToken(integ);
  const headers = { Authorization: `Bearer ${token}`, 'xero-tenant-id': integ.tenant_id, Accept: 'application/json' };
  if (modifiedSince) headers['If-Modified-Since'] = new Date(modifiedSince).toUTCString();
  const res = await fetch(API + path, { headers });
  if (res.status === 304) return null;
  if (res.status === 401 || res.status === 403) {
    await markError(integ, 'Xero refused access. Reconnect Xero to give NorthStar permission again.');
    throw new Error('Xero unauthorized');
  }
  if (!res.ok) throw new Error(`Xero API ${res.status}`);
  return res.json();
}

const mobileOf = (contact) => {
  const phones = contact.Phones || [];
  const pick = phones.find((p) => p.PhoneType === 'MOBILE' && p.PhoneNumber) || phones.find((p) => p.PhoneNumber);
  return pick ? `${pick.PhoneCountryCode ? '+' + pick.PhoneCountryCode : ''}${pick.PhoneAreaCode || ''}${pick.PhoneNumber}` : '';
};

const xeroDate = (s) => {
  const m = /\/Date\((\d+)/.exec(String(s || ''));
  return m ? new Date(Number(m[1])) : s ? new Date(s) : null;
};

export async function importXeroContacts(businessId) {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'xero'", [businessId]);
  const business = await one('SELECT * FROM businesses WHERE id = $1', [businessId]);
  if (!integ || !business) return;
  let page = 1;
  let done = 0;
  try {
    for (;;) {
      const data = await xeroGet(integ, `/Contacts?page=${page}&where=${encodeURIComponent('IsCustomer==true')}&summaryOnly=false`);
      const list = data?.Contacts || [];
      if (page === 1) await query('UPDATE integrations SET progress_done = 0, progress_total = $2 WHERE id = $1', [integ.id, list.length < 100 ? list.length : null]);
      for (const c of list) {
        if (c.ContactStatus === 'ARCHIVED') continue;
        await upsertCustomer(business, { name: c.Name, phone: mobileOf(c), email: c.EmailAddress, source: 'xero', external_id: c.ContactID });
        done++;
      }
      await query('UPDATE integrations SET progress_done = $2 WHERE id = $1', [integ.id, done]);
      if (list.length < 100) break;
      page++;
    }
    await query("UPDATE integrations SET status = 'connected', last_sync_at = now(), progress_total = $2 WHERE id = $1", [integ.id, done]);
    await logEvent(null, { business_id: businessId, type: 'imported', text: `Imported ${done} customers from Xero`, meta: 'Past customers are not messaged' });
  } catch (e) {
    console.error('xero contact import', e.message);
    await query("UPDATE integrations SET status = CASE WHEN status = 'error' THEN 'error' ELSE 'connected' END WHERE id = $1", [integ.id]);
  }
}

// Turn one Xero invoice into a job (if it matches the trigger).
async function handleInvoice(integ, business, invoiceId) {
  const data = await xeroGet(integ, `/Invoices/${invoiceId}`);
  const inv = data?.Invoices?.[0];
  if (!inv || inv.Type !== 'ACCREC') return null;
  const wanted = business.trigger_type === 'complete' ? ['AUTHORISED', 'PAID'] : ['PAID'];
  if (!wanted.includes(inv.Status)) return null;
  const contactData = await xeroGet(integ, `/Contacts/${inv.Contact.ContactID}`);
  const contact = contactData?.Contacts?.[0] || inv.Contact;
  const line = (inv.LineItems || []).find((l) => l.Description) || {};
  return ingestJob(business, {
    source: 'xero',
    customer: { name: contact.Name, phone: mobileOf(contact), email: contact.EmailAddress, external_id: contact.ContactID },
    job: {
      service: String(line.Description || '').split('\n')[0].slice(0, 80),
      reference: inv.InvoiceNumber || '',
      completed_at: inv.Status === 'PAID' ? xeroDate(inv.FullyPaidOnDate) || new Date() : new Date(),
      external_id: `${inv.InvoiceID}:${business.trigger_type}`
    }
  });
}

// https://developer.xero.com/documentation/guides/webhooks/overview
export async function handleXeroWebhook(req, res) {
  const body = req.body instanceof Buffer ? req.body : Buffer.from('');
  const sig = req.get('x-xero-signature') || '';
  if (!config.xero.webhookKey || !safeEqual(sig, hmac('sha256', config.xero.webhookKey, body, 'base64'))) return res.status(401).end();
  res.status(200).end(); // Xero needs a reply within 5 seconds; work continues after.
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return; }
  for (const ev of payload.events || []) {
    if (ev.eventCategory !== 'INVOICE') continue;
    const integs = await many("SELECT * FROM integrations WHERE provider = 'xero' AND tenant_id = $1 AND status <> 'disconnected'", [ev.tenantId]);
    for (const integ of integs) {
      const business = await one('SELECT * FROM businesses WHERE id = $1', [integ.business_id]);
      await handleInvoice(integ, business, ev.resourceId).catch((e) => console.error('xero invoice', e.message));
    }
  }
}

// Polling fallback: catches anything a webhook missed (or if webhooks aren't set up).
export async function pollXero(integ) {
  const business = await one('SELECT * FROM businesses WHERE id = $1', [integ.business_id]);
  const since = integ.last_sync_at || new Date(Date.now() - 2 * 86400000);
  const status = business.trigger_type === 'complete' ? 'AUTHORISED' : 'PAID';
  const where = encodeURIComponent(`Type=="ACCREC" AND Status=="${status}"`);
  const data = await xeroGet(integ, `/Invoices?where=${where}&order=UpdatedDateUTC&page=1`, { modifiedSince: since });
  const started = new Date();
  for (const inv of data?.Invoices || []) await handleInvoice(integ, business, inv.InvoiceID).catch((e) => console.error('xero poll invoice', e.message));
  await query("UPDATE integrations SET last_sync_at = $2, status = CASE WHEN status = 'syncing' THEN status ELSE 'connected' END WHERE id = $1", [integ.id, started]);
}

export async function pollAllXero() {
  if (!providers.xeroReady()) return;
  const list = await many("SELECT * FROM integrations WHERE provider = 'xero' AND status = 'connected'");
  for (const integ of list) await pollXero(integ).catch((e) => console.error('xero poll', e.message));
}

export async function disconnectXero(businessId) {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'xero'", [businessId]);
  if (!integ) return;
  try {
    await fetch('https://identity.xero.com/connect/revocation', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${config.xero.clientId}:${config.xero.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: decrypt(integ.refresh_token) || '' })
    });
  } catch { /* best effort */ }
  await query('DELETE FROM integrations WHERE id = $1', [integ.id]);
  await logEvent(null, { business_id: businessId, type: 'integration', text: 'Disconnected Xero' });
}
