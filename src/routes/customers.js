import { Router } from 'express';
import multer from 'multer';
import { many, one, query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { enqueueJob, processNow, optOutCustomer } from '../lib/engine.js';
import { upsertCustomer, createJob } from '../lib/ingest.js';
import { parseCsv, guessColumns, parseLooseDate, normalizePhone, isEmail, toCsv } from '../lib/util.js';
import { logEvent } from '../lib/events.js';
import { fmtDateTime } from '../lib/time.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const PAGE = 25;

export const STATUSES = ['All', 'Not sent', 'Scheduled', 'Sent', 'Clicked', 'Reviewed', 'Failed', 'Opted out'];
const STATUS_SQL = `CASE WHEN c.opted_out THEN 'Opted out'
  WHEN l.status = 'reviewed' THEN 'Reviewed'
  WHEN l.status = 'clicked' THEN 'Clicked'
  WHEN l.status IN ('sent','delivered','sending') THEN 'Sent'
  WHEN l.status IN ('scheduled','held') THEN 'Scheduled'
  WHEN l.status = 'failed' THEN 'Failed'
  ELSE 'Not sent' END`;
const BASE = `
  FROM customers c
  LEFT JOIN LATERAL (SELECT status, channel, sent_at FROM review_requests rr WHERE rr.customer_id = c.id AND rr.step = 'first' AND rr.status NOT IN ('skipped','cancelled') ORDER BY rr.created_at DESC LIMIT 1) l ON true
  LEFT JOIN LATERAL (SELECT service, reference, completed_at FROM jobs j WHERE j.customer_id = c.id ORDER BY j.completed_at DESC LIMIT 1) j ON true
  WHERE c.business_id = $1`;

const SOURCES = { All: null, Xero: 'xero', 'CSV upload': 'csv', 'Added by hand': 'manual', Webhook: 'webhook' };
const SOURCE_LABEL = { xero: 'Xero', csv: 'CSV upload', manual: 'Added by hand', webhook: 'Webhook' };

function filters(req) {
  const q = String(req.query.q || '').trim();
  const status = STATUSES.includes(req.query.status) ? req.query.status : 'All';
  const source = Object.keys(SOURCES).includes(req.query.source) ? req.query.source : 'All';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const params = [req.business.id];
  let where = '';
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const digits = q.replace(/[^\d]/g, '');
    where += ` AND (lower(c.name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length}`;
    if (digits.length >= 3) { params.push(`%${digits}%`); where += ` OR c.phone LIKE $${params.length}`; }
    where += ')';
  }
  if (SOURCES[source]) { params.push(SOURCES[source]); where += ` AND c.source = $${params.length}`; }
  return { q, status, source, page, params, where };
}

r.get('/customers', async (req, res) => {
  const f = filters(req);
  const countRows = await many(`SELECT ${STATUS_SQL} AS st, count(*)::int AS n ${BASE} ${f.where} GROUP BY 1`, f.params);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of countRows) { counts[row.st] = row.n; counts.All += row.n; }
  const params = [...f.params];
  let statusWhere = '';
  if (f.status !== 'All') { params.push(f.status); statusWhere = ` AND ${STATUS_SQL} = $${params.length}`; }
  params.push(PAGE, (f.page - 1) * PAGE);
  const rows = await many(
    `SELECT c.*, ${STATUS_SQL} AS req_status, l.channel AS req_channel, j.service AS job_service, j.reference AS job_reference, j.completed_at AS job_date
     ${BASE} ${f.where} ${statusWhere} ORDER BY COALESCE(j.completed_at, c.created_at) DESC, c.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = await one('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [req.business.id]);
  const xero = await one("SELECT last_sync_at FROM integrations WHERE business_id = $1 AND provider = 'xero'", [req.business.id]);
  const filteredTotal = counts[f.status];
  res.render('customers/index', {
    title: 'Customers', active: 'customers', rows, counts, statuses: STATUSES.filter((s) => s === 'All' || counts[s] > 0 || ['Not sent', 'Sent', 'Clicked', 'Reviewed', 'Opted out'].includes(s)),
    f, total: total.n, filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / PAGE)), sources: Object.keys(SOURCES), SOURCE_LABEL, xero
  });
});

r.get('/customers.csv', async (req, res) => {
  const rows = await many(`SELECT c.*, ${STATUS_SQL} AS req_status, j.service AS job_service, j.reference AS job_reference, j.completed_at AS job_date ${BASE} ORDER BY c.name`, [req.business.id]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="northstar-customers.csv"');
  res.send(toCsv([
    ['Name', 'Phone', 'Email', 'Source', 'Last job', 'Reference', 'Job date', 'Request status', 'Opted out'],
    ...rows.map((c) => [c.name, c.phone, c.email, SOURCE_LABEL[c.source] || c.source, c.job_service, c.job_reference, c.job_date ? new Date(c.job_date).toISOString().slice(0, 10) : '', c.req_status, c.opted_out ? 'yes' : 'no'])
  ]));
});

r.get('/customers/new', requireRole('manager'), (req, res) => {
  res.render('customers/new', { title: 'Add customer', active: 'customers', values: { send: req.query.send ? '1' : '' }, error: null });
});

r.post('/customers', requireRole('manager'), async (req, res) => {
  const b = req.business;
  const values = { name: String(req.body.name || '').trim(), phone: String(req.body.phone || '').trim(), email: String(req.body.email || '').trim(), service: String(req.body.service || '').trim(), reference: String(req.body.reference || '').trim(), send: req.body.send ? '1' : '' };
  let error = null;
  if (!values.name) error = 'Add the customer’s name.';
  else if (!values.phone && !values.email) error = 'Add a phone number or an email so NorthStar can reach them.';
  else if (values.email && !isEmail(values.email)) error = 'That email address does not look right.';
  else if (values.phone && normalizePhone(values.phone, b.timezone).replace(/\D/g, '').length < 8) error = 'That phone number looks too short. Include the country code, e.g. +356.';
  if (error) return res.status(400).render('customers/new', { title: 'Add customer', active: 'customers', values, error });
  const customer = await upsertCustomer(b, { name: values.name, phone: values.phone, email: values.email, source: 'manual' });
  let job = null;
  if (values.service || values.reference || values.send) ({ job } = await createJob(b, customer, { service: values.service, reference: values.reference, source: 'manual' }));
  if (values.send) {
    const out = await enqueueJob({ business: b, customer, job, manual: true });
    if (out.request) {
      const after = await processNow(out.request.id);
      req.flash('success', describeSend(after, customer, b));
    } else req.flash('error', out.reason);
  } else req.flash('success', `${customer.name} was added.`);
  res.redirect(`/customers/${customer.id}`);
});

function describeSend(rr, customer, b) {
  if (!rr) return 'Request created.';
  if (['sent', 'delivered'].includes(rr.status)) return `Review request sent to ${customer.name}.`;
  if (rr.status === 'scheduled') return `Request queued for ${customer.name}. It goes out ${fmtDateTime(rr.send_at, b.timezone)} because of your quiet hours or limits.`;
  if (rr.status === 'failed') return `The request to ${customer.name} could not be sent: ${rr.failed_reason}`;
  return `Request for ${customer.name} is ${rr.status}.`;
}

// CSV import: upload → match columns → confirm.
r.get('/customers/import', requireRole('manager'), (req, res) => res.render('customers/import', { title: 'Import customers', active: 'customers', error: null }));

r.post('/customers/import', requireRole('manager'), upload.single('file'), async (req, res) => {
  const fail = (error) => res.status(400).render('customers/import', { title: 'Import customers', active: 'customers', error });
  if (!req.file) return fail('Choose a CSV file to upload.');
  const rows = parseCsv(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('That file has no customer rows. The first row should be column names.');
  if (rows.length > 20001) return fail('That file is too big. Split it into files of up to 20,000 customers.');
  const imp = await one('INSERT INTO imports (business_id, headers, rows) VALUES ($1,$2,$3) RETURNING id', [req.business.id, JSON.stringify(rows[0]), JSON.stringify(rows.slice(1))]);
  res.redirect(`/customers/import/${imp.id}`);
});

r.get('/customers/import/:id', requireRole('manager'), async (req, res) => {
  const imp = await one('SELECT * FROM imports WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
  if (!imp) return res.redirect('/customers/import');
  res.render('customers/import-map', { title: 'Match your columns', active: 'customers', imp, guess: guessColumns(imp.headers), preview: imp.rows.slice(0, 5) });
});

r.post('/customers/import/:id', requireRole('manager'), async (req, res) => {
  const b = req.business;
  const imp = await one('SELECT * FROM imports WHERE id = $1 AND business_id = $2', [req.params.id, b.id]);
  if (!imp) return res.redirect('/customers/import');
  const col = (k) => (req.body[k] === '' || req.body[k] === undefined ? -1 : Number(req.body[k]));
  const m = { name: col('name'), first: col('first'), last: col('last'), phone: col('phone'), email: col('email'), service: col('service'), reference: col('reference'), date: col('date') };
  const get = (row, i) => (i >= 0 ? String(row[i] || '').trim() : '');
  const send = req.body.send === '1';
  let added = 0, skipped = 0, queued = 0;
  for (const row of imp.rows) {
    const name = get(row, m.name) || [get(row, m.first), get(row, m.last)].filter(Boolean).join(' ');
    const phone = get(row, m.phone);
    const email = get(row, m.email);
    if (!name || (!phone && !email)) { skipped++; continue; }
    const customer = await upsertCustomer(b, { name, phone, email, source: 'csv' });
    added++;
    const service = get(row, m.service);
    const reference = get(row, m.reference);
    const date = parseLooseDate(get(row, m.date));
    if (service || reference || date || send) {
      const { job } = await createJob(b, customer, { service, reference, completed_at: date, source: 'csv' });
      if (send) {
        const out = await enqueueJob({ business: b, customer, job, manual: true });
        if (out.request) queued++;
      }
    }
  }
  await query('DELETE FROM imports WHERE id = $1', [imp.id]);
  await logEvent(null, { business_id: b.id, type: 'imported', text: `Imported ${added} customers from a CSV file`, meta: send ? `${queued} review requests queued` : 'Past customers are not messaged' });
  if (b.trigger_source === '') await query("UPDATE businesses SET trigger_source = 'csv' WHERE id = $1", [b.id]);
  req.flash('success', `${added} customers imported${skipped ? `, ${skipped} rows skipped (no name, or no phone and email)` : ''}${send ? `. ${queued} review requests queued and will go out within a minute, respecting your quiet hours.` : '.'}`);
  res.redirect(req.body.return_to === 'onboarding' ? '/onboarding?step=4' : '/customers');
});

r.get('/customers/import-template.csv', (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="northstar-customers-template.csv"');
  res.send(toCsv([['Name', 'Phone', 'Email', 'Service', 'Invoice number', 'Date'], ['Maria Borg', '+356 7912 4410', 'maria@example.com', 'Boiler repair', 'INV-1042', '28/10/2026']]));
});

async function loadCustomer(req, res) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) { res.status(404).render('error', { title: 'Customer not found', message: 'That customer does not exist.' }); return null; }
  const c = await one('SELECT * FROM customers WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
  if (!c) res.status(404).render('error', { title: 'Customer not found', message: 'That customer does not exist or was deleted.' });
  return c;
}

r.get('/customers/:id', async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  const [jobs, requests, events, reviews] = await Promise.all([
    many('SELECT * FROM jobs WHERE customer_id = $1 ORDER BY completed_at DESC LIMIT 20', [c.id]),
    many('SELECT * FROM review_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20', [c.id]),
    many('SELECT * FROM events WHERE customer_id = $1 ORDER BY id DESC LIMIT 30', [c.id]),
    many('SELECT * FROM reviews WHERE customer_id = $1 ORDER BY reviewed_at DESC', [c.id])
  ]);
  const pending = requests.find((x) => ['scheduled', 'held'].includes(x.status) && x.step === 'first');
  res.render('customers/show', { title: c.name, active: 'customers', c, jobs, requests, events, reviews, pending, SOURCE_LABEL });
});

r.post('/customers/:id', requireRole('manager'), async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  const name = String(req.body.name || '').trim() || c.name;
  const phone = normalizePhone(req.body.phone, req.business.timezone);
  const email = isEmail(req.body.email) ? String(req.body.email).trim().toLowerCase() : '';
  if (!phone && !email) { req.flash('error', 'Keep at least a phone number or an email.'); return res.redirect(`/customers/${c.id}`); }
  await query('UPDATE customers SET name = $2, phone = $3, email = $4, updated_at = now() WHERE id = $1', [c.id, name, phone, email]);
  req.flash('success', 'Customer details saved.');
  res.redirect(`/customers/${c.id}`);
});

r.post('/customers/:id/send', requireRole('manager'), async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  const b = req.business;
  let job = await one('SELECT * FROM jobs WHERE customer_id = $1 ORDER BY completed_at DESC LIMIT 1', [c.id]);
  const service = String(req.body.service || '').trim();
  if (service || !job) ({ job } = await createJob(b, c, { service, source: 'manual' }));
  const out = await enqueueJob({ business: b, customer: c, job, manual: true });
  if (!out.request) req.flash('error', out.reason);
  else req.flash('success', describeSend(await processNow(out.request.id), c, b));
  res.redirect(req.body.back === 'list' ? (req.get('Referer') || '/customers') : `/customers/${c.id}`);
});

r.post('/customers/:id/cancel', requireRole('manager'), async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  await query("UPDATE review_requests SET status = 'cancelled' WHERE customer_id = $1 AND status IN ('scheduled','held')", [c.id]);
  req.flash('success', 'Waiting requests were cancelled.');
  res.redirect(`/customers/${c.id}`);
});

r.post('/customers/:id/optout', requireRole('manager'), async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  await optOutCustomer(c, { reason: 'Opted out by ' + req.user.name });
  req.flash('success', `${c.name} will not be contacted again.`);
  res.redirect(`/customers/${c.id}`);
});

r.post('/customers/:id/delete', requireRole('manager'), async (req, res) => {
  const c = await loadCustomer(req, res);
  if (!c) return;
  await query('DELETE FROM customers WHERE id = $1', [c.id]);
  req.flash('success', `${c.name} and their history were deleted.`);
  res.redirect('/customers');
});

export default r;
