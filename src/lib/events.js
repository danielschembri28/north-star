import { query } from '../db.js';

export const CHANNEL_LABEL = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
export const STEP_LABEL = { first: 'first request', follow: 'reminder' };

export async function logEvent(db, { business_id, customer_id = null, request_id = null, type, channel = null, text, meta = '' }) {
  const q = db?.query ? db : { query };
  await q.query(
    'INSERT INTO events (business_id, customer_id, request_id, type, channel, text, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [business_id, customer_id, request_id, type, channel, text, meta]
  );
}
