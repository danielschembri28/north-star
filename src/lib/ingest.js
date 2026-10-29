// Shared intake for customers and finished jobs, whatever app they come from.
import { one } from '../db.js';
import { normalizePhone, isEmail } from './util.js';
import { enqueueJob } from './engine.js';

export async function upsertCustomer(business, { name, phone, email, source = 'manual', external_id = null }) {
  const p = normalizePhone(phone, business.timezone);
  const e = isEmail(email) ? String(email).trim().toLowerCase() : '';
  const n = String(name || '').trim() || e || p || 'Customer';
  let existing = null;
  if (external_id) existing = await one('SELECT * FROM customers WHERE business_id = $1 AND source = $2 AND external_id = $3', [business.id, source, external_id]);
  if (!existing && p) existing = await one('SELECT * FROM customers WHERE business_id = $1 AND phone = $2 ORDER BY created_at LIMIT 1', [business.id, p]);
  if (!existing && e) existing = await one('SELECT * FROM customers WHERE business_id = $1 AND lower(email) = $2 ORDER BY created_at LIMIT 1', [business.id, e]);
  if (existing) {
    return one(
      `UPDATE customers SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
              phone = CASE WHEN $3 <> '' THEN $3 ELSE phone END,
              email = CASE WHEN $4 <> '' THEN $4 ELSE email END,
              external_id = COALESCE(external_id, $5), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, String(name || '').trim(), p, e, existing.source === source ? external_id : null]
    );
  }
  return one(
    'INSERT INTO customers (business_id, name, phone, email, source, external_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [business.id, n, p, e, source, external_id]
  );
}

export async function createJob(business, customer, { service = '', reference = '', completed_at = null, source = 'manual', external_id = null }) {
  if (external_id) {
    const dup = await one('SELECT * FROM jobs WHERE business_id = $1 AND source = $2 AND external_id = $3', [business.id, source, external_id]);
    if (dup) return { job: dup, duplicate: true };
  }
  const when = completed_at ? new Date(completed_at) : new Date();
  const job = await one(
    'INSERT INTO jobs (business_id, customer_id, service, reference, source, external_id, completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [business.id, customer.id, String(service || '').slice(0, 200), String(reference || '').slice(0, 100), source, external_id, Number.isNaN(when.getTime()) ? new Date() : when]
  );
  return { job, duplicate: false };
}

export async function ingestJob(business, { source, customer: c, job: j, trigger = true }) {
  const customer = await upsertCustomer(business, { ...c, source });
  const { job, duplicate } = await createJob(business, customer, { ...j, source });
  if (duplicate) return { customer, job, result: { outcome: 'skipped', reason: 'This job was already received.' } };
  const result = trigger ? await enqueueJob({ business, customer, job }) : { outcome: 'skipped', reason: 'Imported without a request' };
  return { customer, job, result };
}
