import { Router } from 'express';
import express from 'express';
import { one } from '../db.js';
import { config } from '../config.js';
import { validTwilioSignature } from '../lib/providers.js';
import { advance, optOutCustomer } from '../lib/engine.js';
import { logEvent, CHANNEL_LABEL } from '../lib/events.js';
import { handleXeroWebhook } from '../lib/xero.js';
import { handleStripeWebhook } from '../lib/stripe.js';
import { ingestJob } from '../lib/ingest.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { query } from '../db.js';

const r = Router();
const form = express.urlencoded({ extended: false });
const raw = express.raw({ type: '*/*', limit: '2mb' });

// Twilio delivery receipts.
r.post('/twilio/status', form, async (req, res) => {
  if (!validTwilioSignature(req)) return res.status(403).end();
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
  const rr = MessageSid ? await one('SELECT * FROM review_requests WHERE provider_id = $1', [MessageSid]) : null;
  if (rr) {
    if (['delivered', 'read'].includes(MessageStatus)) {
      await advance(rr.id, 'delivered', { delivered_at: new Date() });
    } else if (['failed', 'undelivered'].includes(MessageStatus) && !['clicked', 'reviewed', 'failed'].includes(rr.status)) {
      await query("UPDATE review_requests SET status = 'failed', failed_reason = $2 WHERE id = $1", [rr.id, ErrorMessage || `Error ${ErrorCode || ''}`.trim()]);
      const c = await one('SELECT name, phone FROM customers WHERE id = $1', [rr.customer_id]);
      await logEvent(null, {
        business_id: rr.business_id, customer_id: rr.customer_id, request_id: rr.id, type: 'failed', channel: rr.channel,
        text: `${CHANNEL_LABEL[rr.channel] || 'Message'} to ${c?.name || c?.phone || 'customer'} could not be delivered`,
        meta: ErrorCode ? `Carrier error ${ErrorCode}` : 'Not delivered'
      });
    }
  }
  res.status(204).end();
});

// Incoming SMS / WhatsApp replies: STOP opts the customer out.
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|ieqaf|basta)\s*[.!]?\s*$/i;
r.post('/twilio/inbound', form, async (req, res) => {
  if (!validTwilioSignature(req)) return res.status(403).end();
  const from = String(req.body.From || '').replace(/^whatsapp:/, '');
  const body = String(req.body.Body || '');
  const channel = String(req.body.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  if (from && STOP.test(body)) {
    // The same number can be a customer of several businesses on NorthStar:
    // opt it out of whichever ones messaged it most recently on this channel.
    const rows = await query(
      `SELECT DISTINCT ON (c.id) c.* FROM customers c JOIN review_requests r ON r.customer_id = c.id
       WHERE c.phone = $1 AND r.channel = $2 AND r.sent_at > now() - interval '120 days' ORDER BY c.id`,
      [from, channel]
    );
    for (const c of rows.rows) await optOutCustomer(c, { reason: 'Replied STOP', channel });
  }
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

r.post('/xero', raw, handleXeroWebhook);
r.post('/stripe', raw, handleStripeWebhook);

// Generic "a job is done" webhook for Zapier, Make, n8n or your own systems.
// POST /webhooks/inbound/<business webhook key>
// { "name": "...", "phone": "...", "email": "...", "service": "...", "reference": "...", "completed_at": "..." }
r.post('/inbound/:key', express.json({ limit: '256kb' }), form, async (req, res) => {
  const business = await one('SELECT * FROM businesses WHERE webhook_key = $1', [req.params.key]);
  if (!business) return res.status(404).json({ error: 'Unknown webhook key' });
  // Optional signature: X-NorthStar-Signature: sha256=<hmac of body with the key>
  const sig = req.get('x-northstar-signature');
  if (sig && !safeEqual(sig.replace(/^sha256=/, ''), hmac('sha256', business.webhook_key, JSON.stringify(req.body)))) {
    return res.status(401).json({ error: 'Bad signature' });
  }
  const b = req.body || {};
  const name = String(b.name || [b.first_name, b.last_name].filter(Boolean).join(' ') || '').trim();
  if (!name || (!b.phone && !b.email)) return res.status(422).json({ error: 'Send at least a name and a phone or email.' });
  const out = await ingestJob(business, {
    source: 'webhook',
    customer: { name, phone: b.phone, email: b.email, external_id: b.customer_id ? String(b.customer_id) : null },
    job: { service: b.service, reference: b.reference, completed_at: b.completed_at, external_id: b.job_id ? String(b.job_id) : null }
  });
  res.status(202).json({ ok: true, customer_id: out.customer.id, request: out.result.outcome, reason: out.result.reason || null });
});

r.get('/health', (req, res) => res.json({ ok: true, mode: config.messageMode }));

export default r;
