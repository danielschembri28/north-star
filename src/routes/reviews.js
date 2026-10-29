import { Router } from 'express';
import { many, one, query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { recordReview } from '../lib/engine.js';
import { replyOnGoogle, syncGoogleReviews } from '../lib/google.js';
import { clamp } from '../lib/util.js';

const r = Router();

r.get('/reviews', async (req, res) => {
  const b = req.business;
  const platform = ['google', 'facebook', 'other'].includes(req.query.platform) ? req.query.platform : 'All';
  const rating = ['5', '4', 'low'].includes(req.query.rating) ? req.query.rating : 'all';
  const sort = req.query.sort === 'lowest' ? 'lowest' : 'newest';
  const shown = clamp(parseInt(req.query.show, 10) || 24, 24, 2000);
  const params = [b.id];
  let w = 'r.business_id = $1';
  if (platform !== 'All') { params.push(platform); w += ` AND r.platform = $${params.length}`; }
  if (rating === '5') w += ' AND r.rating = 5';
  else if (rating === '4') w += ' AND r.rating = 4';
  else if (rating === 'low') w += ' AND r.rating <= 3';
  const list = await many(
    `SELECT r.*, c.name AS customer_name, j.service, j.reference FROM reviews r
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN review_requests rr ON rr.id = r.request_id LEFT JOIN jobs j ON j.id = rr.job_id
     WHERE ${w} ORDER BY ${sort === 'lowest' ? 'r.rating ASC, r.reviewed_at DESC' : 'r.reviewed_at DESC'} LIMIT ${shown + 1}`,
    params
  );
  const hasMore = list.length > shown;
  if (hasMore) list.length = shown;
  const totals = await one(
    `SELECT count(*)::int AS n, avg(rating)::float AS avg,
       count(*) FILTER (WHERE platform = 'google')::int AS google, count(*) FILTER (WHERE platform = 'facebook')::int AS facebook,
       count(*) FILTER (WHERE request_id IS NOT NULL)::int AS linked
     FROM reviews WHERE business_id = $1`, [b.id]
  );
  const distRows = await many('SELECT rating, count(*)::int AS n FROM reviews WHERE business_id = $1 GROUP BY rating', [b.id]);
  const max = Math.max(1, ...distRows.map((d) => d.n));
  const dist = [5, 4, 3, 2, 1].map((s) => { const n = distRows.find((d) => d.rating === s)?.n || 0; return { s, n, w: Math.max(n ? 2 : 0, Math.round((n / max) * 100)) }; });
  const google = await one("SELECT status, last_sync_at FROM integrations WHERE business_id = $1 AND provider = 'google'", [b.id]);
  const recentCustomers = await many(
    `SELECT DISTINCT ON (c.id) c.id, c.name, rr.sent_at FROM review_requests rr JOIN customers c ON c.id = rr.customer_id
     WHERE rr.business_id = $1 AND rr.sent_at > now() - interval '60 days' AND rr.status <> 'reviewed' ORDER BY c.id, rr.sent_at DESC`, [b.id]
  );
  recentCustomers.sort((a, z) => z.sent_at - a.sent_at);
  res.render('reviews', { title: 'Reviews', active: 'reviews', list, hasMore, shown, totals, dist, platform, rating, sort, google, recentCustomers, today: new Date().toISOString().slice(0, 10) });
});

r.post('/reviews', requireRole('manager'), async (req, res) => {
  const rating = clamp(parseInt(req.body.rating, 10) || 0, 1, 5);
  const platform = ['google', 'facebook', 'other'].includes(req.body.platform) ? req.body.platform : 'google';
  const when = req.body.date ? new Date(req.body.date + 'T12:00:00Z') : new Date();
  const customer_id = /^[0-9a-f-]{36}$/i.test(req.body.customer_id || '') ? req.body.customer_id : null;
  const name = String(req.body.reviewer_name || '').trim();
  if (!customer_id && !name) { req.flash('error', 'Add the reviewer’s name or pick the customer.'); return res.redirect('/reviews'); }
  const { review } = await recordReview(req.business, { platform, rating, text: String(req.body.text || '').trim().slice(0, 4000), reviewer_name: name, reviewed_at: Number.isNaN(when.getTime()) ? new Date() : when, customer_id });
  req.flash('success', review.request_id ? 'Review added and linked to the request that asked for it.' : 'Review added.');
  res.redirect('/reviews');
});

r.post('/reviews/sync', requireRole('manager'), async (req, res) => {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'google'", [req.business.id]);
  if (!integ) { req.flash('error', 'Connect Google Business Profile first.'); return res.redirect('/integrations'); }
  try {
    const n = await syncGoogleReviews(integ);
    req.flash('success', n ? `${n} new Google reviews pulled in.` : 'Up to date. No new Google reviews.');
  } catch (e) {
    req.flash('error', `Google sync failed: ${e.message}`);
  }
  res.redirect('/reviews');
});

r.post('/reviews/:id/reply', requireRole('manager'), async (req, res) => {
  const review = await one('SELECT * FROM reviews WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
  if (!review) return res.redirect('/reviews');
  const text = String(req.body.reply || '').trim().slice(0, 4000);
  if (!text) { req.flash('error', 'Write a reply first.'); return res.redirect('/reviews'); }
  let posted = false;
  if (review.platform === 'google') {
    try { posted = await replyOnGoogle(req.business.id, review, text); } catch (e) { req.flash('error', e.message); }
  }
  await query('UPDATE reviews SET reply_text = $2, replied_at = now() WHERE id = $1', [review.id, text]);
  req.flash('success', posted ? 'Reply posted on Google.' : `Reply saved. Copy it and post it on ${review.platform === 'facebook' ? 'Facebook' : 'the review site'}.`);
  res.redirect('/reviews');
});

r.post('/reviews/:id/delete', requireRole('manager'), async (req, res) => {
  await query('DELETE FROM reviews WHERE id = $1 AND business_id = $2 AND external_id IS NULL', [req.params.id, req.business.id]);
  req.flash('success', 'Review removed from NorthStar.');
  res.redirect('/reviews');
});

export default r;
