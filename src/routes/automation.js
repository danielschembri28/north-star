import { Router } from 'express';
import { one, query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { resumeHeld, tick } from '../lib/engine.js';
import { logEvent } from '../lib/events.js';
import { delayLabel } from '../lib/time.js';
import { clamp } from '../lib/util.js';

const r = Router();
const STEPS = ['trigger', 'delay', 'message', 'wait', 'follow'];
export const CH_NAMES = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email' };

export function channelSummary(b) {
  const order = b.channel_order.split(',').filter((c) => b['channel_' + c]);
  if (!order.length) return 'No channels switched on';
  return order.map((c, i) => (i ? CH_NAMES[c] : CH_NAMES[c].charAt(0).toUpperCase() + CH_NAMES[c].slice(1))).join(', then ');
}

r.get('/automation', async (req, res) => {
  const b = req.business;
  const sel = STEPS.includes(req.query.step) ? req.query.step : 'trigger';
  const week = new Date(Date.now() - 7 * 86400000);
  const s = await one(
    `SELECT
      (SELECT count(*)::int FROM jobs WHERE business_id = $1 AND created_at >= $2) AS jobs,
      (SELECT count(*)::int FROM review_requests WHERE business_id = $1 AND step = 'first' AND sent_at >= $2) AS first_sent,
      (SELECT count(*)::int FROM review_requests WHERE business_id = $1 AND step = 'first' AND sent_at >= $2 AND clicked_at IS NULL AND status NOT IN ('clicked','reviewed')) AS no_click,
      (SELECT count(*)::int FROM review_requests WHERE business_id = $1 AND step = 'follow' AND sent_at >= $2) AS follow_sent,
      (SELECT count(*)::int FROM review_requests WHERE business_id = $1 AND status = 'held') AS held,
      (SELECT count(*)::int FROM review_requests WHERE business_id = $1 AND status = 'scheduled') AS scheduled`,
    [b.id, week]
  );
  const sourceName = { xero: 'Xero', webhook: 'your connected app (webhook)', csv: 'CSV uploads and manual sends', manual: 'manual sends' }[b.trigger_source] || 'your connected app';
  const nodes = [
    { id: 'trigger', kind: 'Trigger', title: b.trigger_type === 'complete' ? 'Job is marked complete' : 'Invoice is marked paid', sub: 'In ' + sourceName, stat: `${s.jobs} this week`, color: '#F2B630', fg: '#0B1530' },
    { id: 'delay', kind: 'Wait', title: delayLabel(b.delay_minutes), sub: 'Then send at the next allowed time', stat: '', color: '#EEF1F7', fg: '#1F3A8A' },
    { id: 'message', kind: 'First message', title: 'Review request', sub: channelSummary(b), stat: `${s.first_sent} sent`, color: '#1F3A8A', fg: '#FFFFFF' },
    { id: 'wait', kind: 'Check', title: `No click after ${b.followup_wait_days} days?`, sub: 'Customers who clicked stop here', stat: `${s.no_click} no click`, color: '#EEF1F7', fg: '#1F3A8A', off: !b.followup_enabled },
    { id: 'follow', kind: 'Follow-up', title: b.followup_enabled ? 'One reminder' : 'Reminder is off', sub: 'Same channel as the first message', stat: b.followup_enabled ? `${s.follow_sent} sent` : '', color: b.followup_enabled ? '#1F3A8A' : '#EEF1F7', fg: b.followup_enabled ? '#FFFFFF' : '#1F3A8A', off: !b.followup_enabled }
  ];
  res.render('automation', { title: 'Automation', active: 'automation', nodes, sel, s, idx: STEPS.indexOf(sel) });
});

r.post('/automation/toggle', requireRole('manager'), async (req, res) => {
  const b = req.business;
  const turnOn = !b.automation_running;
  if (turnOn) {
    await query('UPDATE businesses SET automation_running = true, paused_at = NULL, paused_by = NULL, onboarding_done = true WHERE id = $1', [b.id]);
    const n = await resumeHeld(b.id);
    await logEvent(null, { business_id: b.id, type: 'system', text: `Automation turned on by ${req.user.name}`, meta: n ? `${n} waiting requests released` : '' });
    req.flash('success', n ? `Automation is running. ${n} waiting requests will go out shortly.` : 'Automation is running.');
    tick().catch(() => {});
  } else {
    await query('UPDATE businesses SET automation_running = false, paused_at = now(), paused_by = $2 WHERE id = $1', [b.id, req.user.name]);
    await query("UPDATE review_requests SET status = 'held' WHERE business_id = $1 AND status = 'scheduled' AND manual = false", [b.id]);
    await logEvent(null, { business_id: b.id, type: 'system', text: `Automation paused by ${req.user.name}` });
    req.flash('info', 'Automation is paused. Finished jobs will wait until you resume.');
  }
  const to = String(req.body.to || '/automation');
  res.redirect(to.startsWith('/') && !to.startsWith('//') ? to : '/automation');
});

r.post('/automation', requireRole('manager'), async (req, res) => {
  const b = req.business;
  const step = String(req.body.step || 'trigger');
  if (step === 'trigger') {
    const t = ['paid', 'complete'].includes(req.body.trigger_type) ? req.body.trigger_type : b.trigger_type;
    await query('UPDATE businesses SET trigger_type = $2 WHERE id = $1', [b.id, t]);
  } else if (step === 'delay') {
    const minutes = clamp(parseInt(req.body.delay_minutes, 10) || 0, 0, 30 * 1440);
    await query('UPDATE businesses SET delay_minutes = $2 WHERE id = $1', [b.id, minutes]);
  } else if (step === 'message') {
    const order = String(req.body.channel_order || '').split(',').filter((c) => ['whatsapp', 'sms', 'email'].includes(c));
    const full = [...new Set([...order, 'whatsapp', 'sms', 'email'])].join(',');
    const on = (k) => req.body[k] === '1';
    if (!on('channel_whatsapp') && !on('channel_sms') && !on('channel_email')) {
      req.flash('error', 'Keep at least one channel switched on.');
      return res.redirect('/automation?step=message');
    }
    await query('UPDATE businesses SET channel_order = $2, channel_whatsapp = $3, channel_sms = $4, channel_email = $5 WHERE id = $1', [b.id, full, on('channel_whatsapp'), on('channel_sms'), on('channel_email')]);
  } else if (step === 'wait' || step === 'follow') {
    const days = clamp(parseInt(req.body.followup_wait_days, 10) || b.followup_wait_days, 1, 30);
    const enabled = step === 'follow' ? req.body.followup_enabled === '1' : b.followup_enabled;
    await query('UPDATE businesses SET followup_wait_days = $2, followup_enabled = $3 WHERE id = $1', [b.id, days, enabled]);
    if (!enabled) await query("UPDATE review_requests SET status = 'cancelled' WHERE business_id = $1 AND step = 'follow' AND status IN ('scheduled','held')", [b.id]);
  }
  req.flash('success', 'Saved. Changes apply to new jobs from now on.');
  res.redirect(`/automation?step=${encodeURIComponent(step)}`);
});

export default r;
