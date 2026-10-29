import { Router } from 'express';
import { one, query } from '../db.js';
import { dashboardStats, ratingChart } from '../lib/stats.js';
import { fmtDate } from '../lib/time.js';

const r = Router();

r.get('/dashboard', async (req, res) => {
  const b = req.business;
  if (!b.onboarding_done && b.onboarding_step === 1 && !req.query.skip) return res.redirect('/onboarding');
  const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const stats = await dashboardStats(b, range);
  const chart = ratingChart(stats.series);
  const firstReview = !b.first_review_celebrated
    ? await one('SELECT r.*, c.name AS customer_name FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.business_id = $1 ORDER BY r.reviewed_at ASC LIMIT 1', [b.id])
    : null;
  const pending = await one("SELECT count(*)::int AS n FROM review_requests WHERE business_id = $1 AND status IN ('scheduled','held') AND step = 'first'", [b.id]);
  const anySent = await one('SELECT count(*)::int AS n FROM review_requests WHERE business_id = $1 AND sent_at IS NOT NULL', [b.id]);
  res.render('dashboard', {
    title: 'Dashboard', active: 'home', range, stats, chart, firstReview, pending: pending.n, anySent: anySent.n,
    chartLabels: chart ? [stats.series[0].end, stats.series[6].end, stats.series[11].end].map((d) => fmtDate(d, b.timezone)) : []
  });
});

r.post('/dashboard/celebrated', async (req, res) => {
  await query('UPDATE businesses SET first_review_celebrated = true WHERE id = $1', [req.business.id]);
  res.redirect(req.body.to === 'share' ? '/reviews?share=1' : '/dashboard');
});

r.get('/menu', (req, res) => res.render('menu', { title: 'Menu', active: 'more' }));

export default r;
