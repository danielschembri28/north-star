// The sending engine. Finished jobs become review requests; a background loop
// sends them when they fall due, obeying the business's sending rules.
import { many, one, query } from '../db.js';
import { config, providers } from '../config.js';
import { shortCode } from './crypto.js';
import { logEvent, CHANNEL_LABEL, STEP_LABEL } from './events.js';
import { getTemplates, renderMessage } from './templates.js';
import { sendEmail, sendSms, sendWhatsApp, SendError, reviewEmailHtml } from './providers.js';
import { nextAllowedTime, startOfLocalDay, startOfLocalMonth, fmtDateTime, fmtDate, zonedParts, inQuietHours } from './time.js';

const ORDER = ['held', 'scheduled', 'sending', 'sent', 'delivered', 'clicked', 'reviewed'];
const MAX_JOB_AGE_DAYS = 14;

export const reviewLink = (code) => `${config.baseUrl}/r/${code}`;
export const unsubscribeLink = (code) => `${config.baseUrl}/u/${code}`;

async function newCode() {
  for (;;) {
    const code = shortCode(7);
    if (!(await one('SELECT 1 FROM review_requests WHERE link_code = $1', [code]))) return code;
  }
}

function hasContact(customer) {
  return !!(customer.phone || customer.email);
}

export function availableChannels(business, customer) {
  const order = String(business.channel_order || 'whatsapp,sms,email').split(',').map((c) => c.trim()).filter(Boolean);
  return order.filter((ch) => {
    if (ch === 'whatsapp') return business.channel_whatsapp && customer.phone && providers.whatsappReady();
    if (ch === 'sms') return business.channel_sms && customer.phone && providers.smsReady();
    if (ch === 'email') return business.channel_email && customer.email && providers.emailReady();
    return false;
  });
}

// Moves a request forward through its lifecycle; never backwards.
export async function advance(requestId, status, extra = {}) {
  const r = await one('SELECT id, status, parent_id FROM review_requests WHERE id = $1', [requestId]);
  if (!r) return;
  const cur = ORDER.indexOf(r.status);
  const nxt = ORDER.indexOf(status);
  const sets = [];
  const vals = [requestId];
  if ((cur !== -1 && nxt > cur) || (status === 'reviewed' && r.status !== 'reviewed')) {
    vals.push(status); sets.push(`status = $${vals.length}`);
  }
  for (const [k, v] of Object.entries(extra)) { vals.push(v); sets.push(`${k} = COALESCE(${k}, $${vals.length})`); }
  if (sets.length) await query(`UPDATE review_requests SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/**
 * Turn a finished job into a review request.
 * Returns { outcome: 'scheduled' | 'held' | 'skipped', reason?, request? }.
 */
export async function enqueueJob({ business, customer, job = null, manual = false, sendNow = false }) {
  const base = { business_id: business.id, customer_id: customer.id };
  if (customer.opted_out) {
    if (manual) return { outcome: 'skipped', reason: `${customer.name} has opted out and will not be contacted.` };
    await logEvent(null, { ...base, type: 'skipped', text: `Did not ask ${customer.name}: they opted out`, meta: job?.reference || '' });
    return { outcome: 'skipped', reason: 'opted out' };
  }
  if (!hasContact(customer)) {
    const reason = `${customer.name} has no phone number or email.`;
    if (!manual) await logEvent(null, { ...base, type: 'skipped', text: `Could not ask ${customer.name}: no phone or email`, meta: job?.reference || '' });
    return { outcome: 'skipped', reason };
  }
  const pending = await one("SELECT id FROM review_requests WHERE customer_id = $1 AND status IN ('held','scheduled','sending') AND step = 'first'", [customer.id]);
  if (pending) return { outcome: 'skipped', reason: `${customer.name} already has a request waiting to go out.` };

  if (!manual && business.repeat_guard_days > 0) {
    const recent = await one(
      `SELECT created_at FROM review_requests WHERE customer_id = $1 AND step = 'first' AND status NOT IN ('skipped','cancelled','failed')
       AND created_at > now() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 1`,
      [customer.id, String(business.repeat_guard_days)]
    );
    if (recent) {
      await logEvent(null, { ...base, type: 'skipped', text: `Did not ask ${customer.name} again: asked on ${fmtDate(recent.created_at, business.timezone)}`, meta: `Once every ${business.repeat_guard_days} days rule` });
      return { outcome: 'skipped', reason: 'asked recently' };
    }
  }
  if (!manual && job && Date.now() - new Date(job.completed_at).getTime() > MAX_JOB_AGE_DAYS * 86400000) {
    return { outcome: 'skipped', reason: 'job is too old to ask about' };
  }

  const now = new Date();
  let sendAt = manual || sendNow ? now : new Date(new Date(job?.completed_at || now).getTime() + business.delay_minutes * 60000);
  if (sendAt < now) sendAt = now;
  const status = business.automation_running || manual ? 'scheduled' : 'held';
  const request = await one(
    `INSERT INTO review_requests (business_id, customer_id, job_id, step, status, manual, send_at, link_code)
     VALUES ($1,$2,$3,'first',$4,$5,$6,$7) RETURNING *`,
    [business.id, customer.id, job?.id || null, status, manual, sendAt, await newCode()]
  );
  if (status === 'held') {
    await logEvent(null, { ...base, request_id: request.id, type: 'held', text: `Request for ${customer.name} is waiting: automation is paused`, meta: job?.reference || '' });
  }
  return { outcome: status, request };
}

// Re-queue everything held while automation was paused.
export async function resumeHeld(businessId) {
  const r = await query("UPDATE review_requests SET status = 'scheduled', send_at = GREATEST(send_at, now()) WHERE business_id = $1 AND status = 'held'", [businessId]);
  return r.rowCount;
}

async function claimDue(limit = 25, onlyId = null) {
  // Recover anything a crashed process left half-sent.
  await query("UPDATE review_requests SET status = 'scheduled' WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'");
  const where = onlyId ? 'id = $2' : 'true';
  const params = onlyId ? [limit, onlyId] : [limit];
  return many(
    `UPDATE review_requests SET status = 'sending', claimed_at = now(), attempts = attempts + 1
     WHERE id IN (SELECT id FROM review_requests WHERE status = 'scheduled' AND send_at <= now() AND ${where}
                  ORDER BY send_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    params
  );
}

let ticking = false;
export async function tick() {
  if (ticking) return 0;
  ticking = true;
  let n = 0;
  try {
    for (;;) {
      const batch = await claimDue(25);
      if (!batch.length) break;
      for (const r of batch) {
        await processClaimed(r).catch((e) => console.error('engine error', r.id, e));
        n++;
      }
    }
  } finally {
    ticking = false;
  }
  return n;
}

// Send one specific request right away if it is due (used for "Send request").
export async function processNow(requestId) {
  const [r] = await claimDue(1, requestId);
  if (r) await processClaimed(r);
  return one('SELECT * FROM review_requests WHERE id = $1', [requestId]);
}

async function setStatus(id, fields) {
  const keys = Object.keys(fields);
  await query(`UPDATE review_requests SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function reschedule(r, business, customer, at, reasonText) {
  await setStatus(r.id, { status: 'scheduled', send_at: at, held_notice_at: r.held_notice_at || new Date() });
  if (!r.held_notice_at) {
    const what = r.step === 'follow' ? 'Reminder' : 'Request';
    await logEvent(null, {
      business_id: business.id, customer_id: customer.id, request_id: r.id, type: 'held', channel: r.channel,
      text: `${what} for ${customer.name} held: ${reasonText}`, meta: `Sends ${fmtDateTime(at, business.timezone)}`
    });
  }
}

async function processClaimed(r) {
  const business = await one('SELECT * FROM businesses WHERE id = $1', [r.business_id]);
  const customer = await one('SELECT * FROM customers WHERE id = $1', [r.customer_id]);
  if (!business || !customer) return setStatus(r.id, { status: 'cancelled' });
  const job = r.job_id ? await one('SELECT * FROM jobs WHERE id = $1', [r.job_id]) : null;
  const parent = r.parent_id ? await one('SELECT * FROM review_requests WHERE id = $1', [r.parent_id]) : null;
  const now = new Date();

  if (!business.automation_running && !r.manual) return setStatus(r.id, { status: 'held' });
  if (customer.opted_out) {
    await setStatus(r.id, { status: 'skipped', failed_reason: 'Customer opted out' });
    return;
  }
  if (r.step === 'follow') {
    if (!business.followup_enabled || !parent || ['clicked', 'reviewed'].includes(parent.status) || parent.clicked_at) {
      return setStatus(r.id, { status: 'cancelled' });
    }
  }

  // Quiet hours and Sundays.
  const allowed = nextAllowedTime(now, business);
  if (allowed.getTime() - now.getTime() > 30000) {
    const local = zonedParts(now, business.timezone);
    const quiet = inQuietHours(local.hour * 60 + local.minute, business.quiet_start, business.quiet_end);
    const why = quiet ? 'quiet hours' : 'no messages on Sundays';
    return reschedule(r, business, customer, allowed, why);
  }
  // Daily limit.
  const dayStart = startOfLocalDay(now, business.timezone);
  const today = await one("SELECT count(*)::int AS n FROM review_requests WHERE business_id = $1 AND sent_at >= $2", [business.id, dayStart]);
  if (today.n >= business.daily_limit) {
    const tomorrow = nextAllowedTime(new Date(dayStart.getTime() + 86400000 + 3600000), business);
    return reschedule(r, business, customer, tomorrow, `daily limit of ${business.daily_limit} reached`);
  }
  // Monthly allowance on the plan.
  const monthStart = startOfLocalMonth(now, business.timezone);
  const month = await one("SELECT count(*)::int AS n FROM review_requests WHERE business_id = $1 AND sent_at >= $2", [business.id, monthStart]);
  if (business.monthly_message_limit > 0 && month.n >= business.monthly_message_limit) {
    const tomorrow = nextAllowedTime(new Date(dayStart.getTime() + 86400000 + 3600000), business);
    return reschedule(r, business, customer, tomorrow, `monthly allowance of ${business.monthly_message_limit} messages used`);
  }

  // Pick channels: reminders use the same channel as the first message.
  let channels = availableChannels(business, customer);
  if (r.step === 'follow' && parent?.channel) channels = channels.includes(parent.channel) ? [parent.channel] : channels.slice(0, 1);
  if (!channels.length) {
    const reason = customer.phone || customer.email ? 'No enabled channel can reach this customer' : 'No phone number or email';
    await setStatus(r.id, { status: 'failed', failed_reason: reason });
    await logEvent(null, { business_id: business.id, customer_id: customer.id, request_id: r.id, type: 'failed', text: `Could not send to ${customer.name}`, meta: reason });
    return;
  }

  const templates = await getTemplates(business.id);
  const link = reviewLink(r.link_code);
  const logoUrl = business.logo_file_id ? `${config.baseUrl}/files/${business.logo_file_id}` : '';
  let lastError = null;

  for (const channel of channels) {
    const tpl = templates[channel][r.step];
    const msg = renderMessage(channel, tpl, { customerName: customer.name, businessName: business.name, service: job?.service, link });
    try {
      let providerId;
      if (channel === 'sms') providerId = await sendSms({ to: customer.phone, body: msg.body });
      else if (channel === 'whatsapp') providerId = await sendWhatsApp({ to: customer.phone, body: msg.body, step: r.step, vars: msg.vars });
      else {
        const unsub = unsubscribeLink(r.link_code);
        providerId = await sendEmail({
          to: customer.email,
          subject: msg.subject,
          text: `${msg.body}\n\nLeave a review: ${link}\n\nUnsubscribe: ${unsub}`,
          html: reviewEmailHtml({ businessName: business.name, logoUrl, body: msg.body, link, unsubscribeUrl: unsub }),
          headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          from: emailFrom(business)
        });
      }
      const console_ = config.messageMode === 'console';
      await setStatus(r.id, {
        status: console_ ? 'delivered' : 'sent', channel, sent_at: now, delivered_at: console_ ? now : null, provider_id: providerId, failed_reason: null
      });
      await query('UPDATE customers SET last_requested_at = $2, updated_at = now() WHERE id = $1', [customer.id, now]);
      const who = r.step === 'follow' ? `Reminder sent to ${customer.name}` : `Review request sent to ${customer.name}`;
      await logEvent(null, {
        business_id: business.id, customer_id: customer.id, request_id: r.id, type: 'sent', channel,
        text: who, meta: [CHANNEL_LABEL[channel], STEP_LABEL[r.step], job?.reference].filter(Boolean).join(' · ')
      });
      if (r.step === 'first' && business.followup_enabled) {
        await query(
          `INSERT INTO review_requests (business_id, customer_id, job_id, parent_id, step, status, channel, manual, send_at, link_code)
           VALUES ($1,$2,$3,$4,'follow','scheduled',$5,$6,$7,$8)`,
          [business.id, customer.id, r.job_id, r.id, channel, r.manual, new Date(now.getTime() + business.followup_wait_days * 86400000), await newCode()]
        );
      }
      return;
    } catch (e) {
      lastError = e;
      console.warn(`send failed (${channel}) for request ${r.id}: ${e.message}`);
      if (!(e instanceof SendError)) break;
      // Temporary problem on the only channel: retry later.
      if (!e.permanent && channels.length === 1 && r.attempts < 3) {
        await setStatus(r.id, { status: 'scheduled', send_at: new Date(now.getTime() + r.attempts * 10 * 60000) });
        return;
      }
    }
  }
  await setStatus(r.id, { status: 'failed', failed_reason: lastError?.message?.slice(0, 300) || 'Unknown error' });
  await logEvent(null, {
    business_id: business.id, customer_id: customer.id, request_id: r.id, type: 'failed', channel: channels[channels.length - 1],
    text: `Message to ${customer.name} could not be delivered`, meta: lastError?.message?.slice(0, 160) || ''
  });
}

export function emailFrom(business) {
  // "Harbourline Plumbing <reviews@yourdomain.com>" using the configured address.
  const m = /<([^>]+)>/.exec(config.email.from);
  const addr = m ? m[1] : config.email.from;
  const safeName = String(business.name).replace(/["<>]/g, '');
  return `${safeName} <${addr}>`;
}

export async function recordClick(code) {
  const r = await one('SELECT * FROM review_requests WHERE link_code = $1', [code]);
  if (!r) return null;
  if (!r.clicked_at && ['sent', 'delivered', 'clicked'].includes(r.status)) {
    const now = new Date();
    await advance(r.id, 'clicked', { clicked_at: now });
    if (r.parent_id) await advance(r.parent_id, 'clicked', { clicked_at: now });
    const c = await one('SELECT name FROM customers WHERE id = $1', [r.customer_id]);
    await logEvent(null, {
      business_id: r.business_id, customer_id: r.customer_id, request_id: r.id, type: 'clicked', channel: r.channel,
      text: `${c?.name || 'A customer'} opened the review link`, meta: [CHANNEL_LABEL[r.channel], STEP_LABEL[r.step]].filter(Boolean).join(' · ')
    });
  }
  return r;
}

export async function optOutCustomer(customer, { reason = 'Replied STOP', channel = null, requestId = null } = {}) {
  if (customer.opted_out) return false;
  await query('UPDATE customers SET opted_out = true, opted_out_at = now(), opt_out_reason = $2, updated_at = now() WHERE id = $1', [customer.id, reason]);
  await query("UPDATE review_requests SET status = 'cancelled' WHERE customer_id = $1 AND status IN ('held','scheduled')", [customer.id]);
  await logEvent(null, {
    business_id: customer.business_id, customer_id: customer.id, request_id: requestId, type: 'opted_out', channel,
    text: reason === 'Replied STOP' ? `${customer.name} replied STOP and was opted out` : `${customer.name} was opted out`, meta: [CHANNEL_LABEL[channel], reason].filter(Boolean).join(' · ')
  });
  return true;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean);

export function namesMatch(reviewer, customer) {
  const a = norm(reviewer);
  const b = norm(customer);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  // "Maria B" or "Maria Borg" vs "Maria Borg"
  if (a[0] === b[0] && a.length > 1 && b.length > 1 && b[b.length - 1].startsWith(a[a.length - 1])) return true;
  return false;
}

/**
 * Store a review (from Google sync or added by hand) and link it to the
 * customer and request it came from.
 */
export async function recordReview(business, { platform = 'google', rating, text = '', reviewer_name = '', reviewed_at = new Date(), external_id = null, customer_id = null, reply_text = null, replied_at = null }) {
  if (external_id) {
    const existing = await one('SELECT * FROM reviews WHERE business_id = $1 AND platform = $2 AND external_id = $3', [business.id, platform, external_id]);
    if (existing) {
      await query('UPDATE reviews SET rating = $2, text = $3, reply_text = COALESCE($4, reply_text), replied_at = COALESCE($5, replied_at) WHERE id = $1', [existing.id, rating, text, reply_text, replied_at]);
      return { review: existing, created: false };
    }
  }
  let customer = customer_id ? await one('SELECT * FROM customers WHERE id = $1 AND business_id = $2', [customer_id, business.id]) : null;
  let request = null;
  if (!customer && reviewer_name) {
    const candidates = await many(
      `SELECT c.*, r.id AS req_id FROM review_requests r JOIN customers c ON c.id = r.customer_id
       WHERE r.business_id = $1 AND r.step = 'first' AND r.sent_at > $2::timestamptz - interval '60 days' AND r.status <> 'reviewed'
       ORDER BY r.sent_at DESC`,
      [business.id, reviewed_at]
    );
    customer = candidates.find((c) => namesMatch(reviewer_name, c.name)) || null;
  }
  if (customer) {
    request = await one("SELECT * FROM review_requests WHERE customer_id = $1 AND step = 'first' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1", [customer.id]);
  }
  const review = await one(
    `INSERT INTO reviews (business_id, customer_id, request_id, platform, rating, text, reviewer_name, reviewed_at, external_id, reply_text, replied_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [business.id, customer?.id || null, request?.id || null, platform, rating, text, reviewer_name || customer?.name || '', reviewed_at, external_id, reply_text, replied_at]
  );
  if (request && request.status !== 'reviewed') {
    await advance(request.id, 'reviewed', { reviewed_at: reviewed_at });
    await query("UPDATE review_requests SET status = 'cancelled' WHERE parent_id = $1 AND status IN ('scheduled','held')", [request.id]);
  }
  const label = { google: 'Google', facebook: 'Facebook' }[platform] || 'another site';
  await logEvent(null, {
    business_id: business.id, customer_id: customer?.id || null, request_id: request?.id || null, type: 'reviewed', channel: request?.channel || null,
    text: `${customer?.name || reviewer_name || 'Someone'} left a ${rating}-star review on ${label}`,
    meta: request ? [CHANNEL_LABEL[request.channel], STEP_LABEL[request.step]].filter(Boolean).join(' · ') : 'Not linked to a request'
  });
  return { review, created: true };
}

let timer = null;
export function startEngine() {
  if (timer) return;
  const run = () => tick().catch((e) => console.error('engine tick failed', e));
  timer = setInterval(run, config.engineIntervalSeconds * 1000);
  timer.unref?.();
  setTimeout(run, 2000).unref?.();
  console.log(`Sending engine running every ${config.engineIntervalSeconds}s (message mode: ${config.messageMode})`);
}

export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}
