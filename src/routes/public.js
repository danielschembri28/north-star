// Pages customers see: the review link and the unsubscribe link.
import { Router } from 'express';
import express from 'express';
import { one } from '../db.js';
import { recordClick, optOutCustomer } from '../lib/engine.js';
import { firstName } from '../lib/util.js';

const r = Router();

// Link previews (WhatsApp, iMessage, Slack…) fetch URLs too; don't count those as clicks.
const BOT = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|embedly|curl|wget|python-requests|headless/i;

r.get('/r/:code', async (req, res) => {
  const reqRow = await one('SELECT * FROM review_requests WHERE link_code = $1', [req.params.code]);
  if (!reqRow) return res.status(404).render('error', { title: 'Link not found', message: 'This review link is not valid. It may have been mistyped.' });
  if (!BOT.test(req.get('user-agent') || '') && req.method === 'GET') await recordClick(req.params.code);
  const business = await one('SELECT * FROM businesses WHERE id = $1', [reqRow.business_id]);
  const customer = await one('SELECT name FROM customers WHERE id = $1', [reqRow.customer_id]);
  const links = [
    business.google_review_url && { key: 'google', label: 'Review us on Google', url: business.google_review_url },
    business.facebook_review_url && { key: 'facebook', label: 'Review us on Facebook', url: business.facebook_review_url }
  ].filter(Boolean);
  res.set('Cache-Control', 'no-store');
  if (links.length === 1 && req.query.choose === undefined) return res.redirect(302, links[0].url);
  res.render('public/review', { title: `Review ${business.name}`, business, links, code: req.params.code, name: firstName(customer?.name) });
});

r.get('/r/:code/go/:platform', async (req, res) => {
  const reqRow = await one('SELECT business_id FROM review_requests WHERE link_code = $1', [req.params.code]);
  if (!reqRow) return res.redirect('/');
  const b = await one('SELECT google_review_url, facebook_review_url FROM businesses WHERE id = $1', [reqRow.business_id]);
  const url = req.params.platform === 'facebook' ? b.facebook_review_url : b.google_review_url;
  res.redirect(302, url || `/r/${req.params.code}?choose`);
});

async function loadForUnsub(code) {
  const row = await one('SELECT * FROM review_requests WHERE link_code = $1', [code]);
  if (!row) return null;
  const customer = await one('SELECT * FROM customers WHERE id = $1', [row.customer_id]);
  const business = await one('SELECT * FROM businesses WHERE id = $1', [row.business_id]);
  return { row, customer, business };
}

r.get('/u/:code', async (req, res) => {
  const d = await loadForUnsub(req.params.code);
  if (!d) return res.status(404).render('error', { title: 'Link not found', message: 'This link is not valid.' });
  res.render('public/unsubscribe', { title: 'Unsubscribe', business: d.business, code: req.params.code, done: d.customer.opted_out });
});

// Also handles RFC 8058 one-click unsubscribe POSTs from email clients.
r.post('/u/:code', express.urlencoded({ extended: false }), async (req, res) => {
  const d = await loadForUnsub(req.params.code);
  if (!d) return res.status(404).send('Not found');
  await optOutCustomer(d.customer, { reason: 'Unsubscribed by link', channel: d.row.channel, requestId: d.row.id });
  if (req.body?.['List-Unsubscribe'] === 'One-Click') return res.status(200).send('Unsubscribed');
  res.render('public/unsubscribe', { title: 'Unsubscribed', business: d.business, code: req.params.code, done: true });
});

r.get('/files/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
  const f = await one('SELECT mime, data FROM files WHERE id = $1', [req.params.id]);
  if (!f) return res.status(404).end();
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(f.data);
});

export default r;
