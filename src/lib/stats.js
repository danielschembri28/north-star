import { many, one } from '../db.js';
import { pct } from './util.js';
import { CHANNEL_LABEL } from './events.js';

export async function setupProgress(business) {
  const [cust, integ] = await Promise.all([
    one('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [business.id]),
    one("SELECT count(*)::int AS n FROM integrations WHERE business_id = $1 AND status IN ('connected','syncing')", [business.id])
  ]);
  const items = [
    { done: !!business.name, label: 'Add your business details', href: '/settings#profile' },
    { done: !!business.google_review_url, label: 'Add your Google review link', href: '/settings#links' },
    { done: !!business.facebook_review_url, label: 'Add your Facebook link to finish', href: '/settings#links' },
    { done: integ.n > 0 || ['webhook', 'csv', 'manual'].includes(business.trigger_source), label: 'Connect the app you use', href: '/integrations' },
    { done: cust.n > 0, label: 'Bring in your customers', href: '/customers/import' },
    { done: business.onboarding_done || business.onboarding_step > 6, label: 'Choose your channels', href: '/onboarding?step=6' },
    { done: business.templates_saved || business.onboarding_done, label: 'Check your messages', href: '/messages' },
    { done: business.automation_running, label: 'Turn on automation', href: '/automation' }
  ];
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done) || null;
  return { done, total: items.length, pct: Math.round((done / items.length) * 100), next, items };
}

function delta(cur, prev, kind) {
  if (prev === null || prev === undefined || (kind !== 'rating' && prev === 0 && cur === 0)) return { text: 'No change on last period', cls: 'flat' };
  if (kind === 'rating') {
    if (!prev) return { text: 'First reviews this period', cls: 'flat' };
    if (Math.abs(cur - prev) < 0.05) return { text: 'Same as last period', cls: 'flat' };
    return { text: `${cur > prev ? 'Up' : 'Down'} from ${prev.toFixed(1)}`, cls: cur > prev ? '' : 'down' };
  }
  if (kind === 'pts') {
    const d = cur - prev;
    if (d === 0) return { text: 'Same as last period', cls: 'flat' };
    return { text: `${d > 0 ? '+' : ''}${d} pts on last period`, cls: d > 0 ? '' : 'down' };
  }
  if (prev === 0) return { text: 'New this period', cls: '' };
  const d = Math.round(((cur - prev) / prev) * 100);
  if (d === 0) return { text: 'Same as last period', cls: 'flat' };
  return { text: `${d > 0 ? '+' : ''}${d}% on last period`, cls: d > 0 ? '' : 'down' };
}

async function periodNumbers(businessId, from, to) {
  const req = await one(
    `SELECT count(*)::int AS sent,
            count(*) FILTER (WHERE clicked_at IS NOT NULL OR status IN ('clicked','reviewed'))::int AS clicked,
            count(*) FILTER (WHERE status = 'reviewed')::int AS reviewed
       FROM review_requests WHERE business_id = $1 AND step = 'first' AND sent_at >= $2 AND sent_at < $3`,
    [businessId, from, to]
  );
  const rev = await one(
    'SELECT count(*)::int AS n, avg(rating)::float AS avg FROM reviews WHERE business_id = $1 AND reviewed_at >= $2 AND reviewed_at < $3',
    [businessId, from, to]
  );
  return { ...req, reviews: rev.n, avg: rev.avg };
}

export async function dashboardStats(business, rangeDays) {
  const now = new Date();
  const from = new Date(now.getTime() - rangeDays * 86400000);
  const prevFrom = new Date(from.getTime() - rangeDays * 86400000);
  const [cur, prev] = await Promise.all([periodNumbers(business.id, from, now), periodNumbers(business.id, prevFrom, from)]);
  const allTime = await one('SELECT count(*)::int AS n, avg(rating)::float AS avg FROM reviews WHERE business_id = $1', [business.id]);
  const prevAll = await one('SELECT avg(rating)::float AS avg FROM reviews WHERE business_id = $1 AND reviewed_at < $2', [business.id, from]);

  const clickRate = pct(cur.clicked, cur.sent);
  const responseRate = pct(cur.reviewed, cur.sent);
  const avgNow = allTime.avg || 0;
  const kpis = [
    { label: 'Requests sent', value: String(cur.sent), suffix: '', ...delta(cur.sent, prev.sent) },
    { label: 'Click rate', value: String(clickRate), suffix: '%', ...delta(clickRate, pct(prev.clicked, prev.sent), 'pts') },
    { label: 'Reviews received', value: String(cur.reviews), suffix: '', ...delta(cur.reviews, prev.reviews) },
    { label: 'Average rating', value: avgNow ? avgNow.toFixed(1) : '–', suffix: avgNow ? ' ★' : '', ...delta(avgNow, prevAll.avg || 0, 'rating') },
    { label: 'Response rate', value: String(responseRate), suffix: '%', ...delta(responseRate, pct(prev.reviewed, prev.sent), 'pts') }
  ];

  const chRows = await many(
    `SELECT channel, count(*)::int AS sent,
            count(*) FILTER (WHERE clicked_at IS NOT NULL OR status IN ('clicked','reviewed'))::int AS clicked,
            count(*) FILTER (WHERE status = 'reviewed')::int AS reviewed
       FROM review_requests WHERE business_id = $1 AND step = 'first' AND sent_at >= $2 AND channel IS NOT NULL
      GROUP BY channel`,
    [business.id, from]
  );
  const channels = ['whatsapp', 'sms', 'email'].map((ch) => {
    const r = chRows.find((x) => x.channel === ch) || { sent: 0, clicked: 0, reviewed: 0 };
    return { name: CHANNEL_LABEL[ch], sent: r.sent, reviews: r.reviewed, rate: pct(r.clicked, r.sent) };
  });

  // Running average rating at the end of each of the last 12 weeks.
  const weeks = [];
  for (let i = 11; i >= 0; i--) weeks.push(new Date(now.getTime() - i * 7 * 86400000));
  const ratings = await many('SELECT rating, reviewed_at FROM reviews WHERE business_id = $1 AND reviewed_at <= $2 ORDER BY reviewed_at', [business.id, now]);
  const series = weeks.map((end) => {
    const upTo = ratings.filter((r) => new Date(r.reviewed_at) <= end);
    return { end, avg: upTo.length ? upTo.reduce((a, r) => a + r.rating, 0) / upTo.length : null };
  });

  const recent = await many(
    `SELECT r.*, c.name AS customer_name FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.business_id = $1 ORDER BY r.reviewed_at DESC LIMIT 4`,
    [business.id]
  );

  return {
    kpis,
    funnel: { sent: cur.sent, clicked: cur.clicked, reviewed: cur.reviewed, clickRate, responseRate, conv: pct(cur.reviewed, cur.clicked) },
    channels,
    series,
    recent,
    totals: { reviews: allTime.n, avg: allTime.avg }
  };
}

// Server-rendered SVG path for the rating line chart (viewBox 600×240).
export function ratingChart(series) {
  const pts = series.filter((p) => p.avg !== null);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.avg);
  let lo = Math.floor((Math.min(...vals) - 0.25) * 2) / 2;
  lo = Math.max(1, Math.min(lo, 4.5));
  const hi = 5;
  const x0 = 40, x1 = 579, yTop = 20, yBot = 200;
  const step = (x1 - x0) / (series.length - 1);
  const y = (v) => yBot - ((v - lo) / (hi - lo)) * (yBot - yTop);
  const coords = series.map((p, i) => (p.avg === null ? null : [x0 + i * step, y(p.avg)])).filter(Boolean);
  const line = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${yBot} L${coords[0][0].toFixed(1)} ${yBot} Z`;
  const last = coords[coords.length - 1];
  const mid = (lo + hi) / 2;
  return {
    line, area, last, lastValue: vals[vals.length - 1].toFixed(2), first: vals[0], lastAvg: vals[vals.length - 1],
    labels: [{ y: yTop, v: hi.toFixed(1) }, { y: (yTop + yBot) / 2, v: mid.toFixed(2).replace(/0$/, '') }, { y: yBot, v: lo.toFixed(1) }]
  };
}
