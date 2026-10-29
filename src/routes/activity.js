import { Router } from 'express';
import { many } from '../db.js';
import { dayLabel } from '../lib/time.js';
import { toCsv } from '../lib/util.js';

const r = Router();
const PAGE = 50;
const STATUS_TYPES = {
  'Any status': null, Delivered: ['sent'], Clicked: ['clicked'], Reviewed: ['reviewed'], Failed: ['failed'], 'Opted out': ['opted_out'], Scheduled: ['held'], Skipped: ['skipped']
};

export function eventStatus(e) {
  switch (e.type) {
    case 'sent': return e.delivered_at ? 'Delivered' : 'Sent';
    case 'clicked': return 'Clicked';
    case 'reviewed': return 'Reviewed';
    case 'failed': return 'Failed';
    case 'opted_out': return 'Opted out';
    case 'held': return 'Scheduled';
    case 'skipped': return 'Skipped';
    case 'imported': return 'Imported';
    case 'integration': return /stopped|refused|expired/i.test(e.text + e.meta) ? 'Problem' : 'Connected';
    default: return 'Note';
  }
}

function where(req) {
  const params = [req.business.id];
  let w = 'e.business_id = $1';
  const ch = ['whatsapp', 'sms', 'email'].includes(req.query.channel) ? req.query.channel : null;
  if (ch) { params.push(ch); w += ` AND e.channel = $${params.length}`; }
  const st = Object.keys(STATUS_TYPES).includes(req.query.status) ? req.query.status : 'Any status';
  if (STATUS_TYPES[st]) { params.push(STATUS_TYPES[st]); w += ` AND e.type = ANY($${params.length})`; }
  return { params, w, ch, st };
}

r.get('/activity', async (req, res) => {
  const b = req.business;
  const { params, w, ch, st } = where(req);
  const before = parseInt(req.query.before, 10);
  if (before) { params.push(before); }
  params.push(PAGE + 1);
  const rows = await many(
    `SELECT e.*, rr.delivered_at FROM events e LEFT JOIN review_requests rr ON rr.id = e.request_id
     WHERE ${w} ${before ? `AND e.id < $${params.length - 1}` : ''} ORDER BY e.id DESC LIMIT $${params.length}`,
    params
  );
  const more = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const days = [];
  for (const e of list) {
    const label = dayLabel(e.created_at, b.timezone);
    let d = days[days.length - 1];
    if (!d || d.label !== label) { d = { label, events: [] }; days.push(d); }
    d.events.push({ ...e, status: eventStatus(e) });
  }
  const upcoming = before ? [] : await many(
    `SELECT rr.*, c.name FROM review_requests rr JOIN customers c ON c.id = rr.customer_id
     WHERE rr.business_id = $1 AND rr.status IN ('scheduled','held') ORDER BY rr.send_at LIMIT 8`,
    [b.id]
  );
  res.render('activity', {
    title: 'Activity', active: 'activity', days, more, nextBefore: list.length ? list[list.length - 1].id : null,
    ch: ch || 'All', st, statuses: Object.keys(STATUS_TYPES), upcoming
  });
});

r.get('/activity.csv', async (req, res) => {
  const b = req.business;
  const { params, w } = where(req);
  const rows = await many(`SELECT e.*, rr.delivered_at, c.name AS customer, c.phone, c.email FROM events e LEFT JOIN review_requests rr ON rr.id = e.request_id LEFT JOIN customers c ON c.id = e.customer_id WHERE ${w} ORDER BY e.id DESC LIMIT 10000`, params);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="northstar-activity.csv"');
  res.send(toCsv([
    ['Date and time (UTC)', 'What happened', 'Details', 'Channel', 'Status', 'Customer', 'Phone', 'Email'],
    ...rows.map((e) => [new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19), e.text, e.meta, e.channel || '', eventStatus(e), e.customer || '', e.phone || '', e.email || ''])
  ]));
});

export default r;
