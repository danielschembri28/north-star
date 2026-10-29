// Fills a demo business ("Harbourline Plumbing") with 90 days of realistic
// activity so you can explore NorthStar or demo it to a prospect.
//   npm run seed:demo            → creates demo@northstar.app / northstar-demo
//   npm run seed:demo -- --reset → deletes and recreates the demo business
import { pool, migrate, one, query } from '../src/db.js';
import { hashPassword, shortCode } from '../src/lib/crypto.js';

const EMAIL = process.env.DEMO_EMAIL || 'demo@northstar.app';
const PASSWORD = process.env.DEMO_PASSWORD || 'northstar-demo';
const reset = process.argv.includes('--reset');

const FIRST = ['Maria', 'Joseph', 'Anna', 'Luke', 'Rita', 'Paul', 'Sarah', 'Kevin', 'Claire', 'David', 'Daniela', 'Mark', 'Josianne', 'Matthew', 'Christine', 'Andrew', 'Nicole', 'Ryan', 'Elaine', 'Karl', 'Simon', 'Rebecca', 'Jean', 'Charlene', 'Neil', 'Roberta', 'Clayton', 'Maronna', 'Stephen', 'Graziella'];
const LAST = ['Borg', 'Camilleri', 'Grech', 'Farrugia', 'Zammit', 'Galea', 'Micallef', 'Attard', 'Abela', 'Spiteri', 'Vella', 'Cassar', 'Azzopardi', 'Mifsud', 'Pace', 'Debono', 'Caruana', 'Fenech', 'Sultana', 'Schembri', 'Agius', 'Bonello', 'Ellul', 'Tanti', 'Portelli'];
const SERVICES = ['Boiler repair', 'Bathroom refit', 'Leak inspection', 'Water heater install', 'Blocked drain', 'Tap replacement', 'Annual service', 'Shower repair', 'Radiator service', 'Toilet repair', 'Pipe replacement', 'Kitchen sink install'];
const GOOD = ['Fixed our leaking boiler the same afternoon. Really tidy work and a fair price.', 'Turned up on time, explained everything clearly. Would book again.', 'Friendly team and quick to sort out the blocked drain.', 'Professional from start to finish. Left the place cleaner than they found it.', 'Great service, very reasonable price.', 'Came the same day I called. Highly recommend.', 'Mark was brilliant, sorted the problem in under an hour.', 'Honest advice, did not try to upsell. Will use again.', '', '', 'Very happy with the new bathroom.', 'Polite, punctual and tidy.'];
const OK = ['Good job on the bathroom tap. Took a little longer than quoted but no complaints.', 'Work was good, a bit hard to get through on the phone.', ''];
const MEH = ['The work was fine but I had to call twice to confirm the appointment time.', 'Arrived late, but fixed it in the end.'];

let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const DAY = 86400000;

async function main() {
  await migrate(() => {});
  let user = await one('SELECT * FROM users WHERE email = $1', [EMAIL]);
  if (!user) user = await one('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [EMAIL, 'Mark Vella', await hashPassword(PASSWORD)]);
  const existing = await one("SELECT b.* FROM businesses b JOIN memberships m ON m.business_id = b.id WHERE m.user_id = $1 AND b.name = 'Harbourline Plumbing'", [user.id]);
  if (existing && !reset) {
    console.log(`Demo already exists. Sign in as ${EMAIL} / ${PASSWORD} (use --reset to rebuild it).`);
    return;
  }
  if (existing) await query('DELETE FROM businesses WHERE id = $1', [existing.id]);

  const b = await one(
    `INSERT INTO businesses (name, phone, timezone, google_review_url, facebook_review_url, automation_running, trigger_type, trigger_source,
       delay_minutes, onboarding_step, onboarding_done, templates_saved, first_review_celebrated, plan, plan_status, monthly_message_limit)
     VALUES ('Harbourline Plumbing', '+356 2100 0000', 'Europe/Malta', 'https://g.page/r/harbourline/review', '', true, 'paid', 'webhook',
       1440, 8, true, true, true, 'growth', 'active', 500) RETURNING *`
  );
  await query("INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,'owner')", [user.id, b.id]);
  for (const [name, email, role] of [['Sophie Grech', 'sophie@harbourline.mt', 'manager'], ['Ryan Caruana', 'ryan@harbourline.mt', 'viewer']]) {
    let u = await one('SELECT * FROM users WHERE email = $1', [email]);
    if (!u) u = await one('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING *', [email, name, await hashPassword(PASSWORD)]);
    await query('INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, b.id, role]);
  }

  const now = Date.now();
  const used = new Set();
  let inv = 900;
  const ev = async (type, customer, request, channel, text, meta, at) =>
    query('INSERT INTO events (business_id, customer_id, request_id, type, channel, text, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [b.id, customer, request, type, channel, text, meta, new Date(at)]);
  const label = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

  for (let i = 0; i < 160; i++) {
    let name;
    do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
    used.add(name);
    const hasPhone = rand() > 0.1;
    const hasEmail = rand() > 0.35 || !hasPhone;
    const phone = hasPhone ? `+356${pick(['79', '99', '77'])}${String(Math.floor(rand() * 1e6)).padStart(6, '0')}` : '';
    const email = hasEmail ? `${name.toLowerCase().replace(' ', '.')}@email.com` : '';
    const ageDays = rand() * 92;
    const jobAt = now - ageDays * DAY;
    const c = await one('INSERT INTO customers (business_id, name, phone, email, source, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.id, name, phone, email, pick(['webhook', 'webhook', 'csv', 'manual']), new Date(jobAt - 30 * DAY)]);
    inv++;
    const service = pick(SERVICES);
    const ref = `INV-${inv}`;
    const job = await one('INSERT INTO jobs (business_id, customer_id, service, reference, source, completed_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *', [b.id, c.id, service, ref, 'webhook', new Date(jobAt)]);

    // Recent jobs (under a day old) are still waiting for their delay.
    if (ageDays < 1) {
      const rr = await one("INSERT INTO review_requests (business_id, customer_id, job_id, step, status, send_at, link_code, created_at) VALUES ($1,$2,$3,'first','scheduled',$4,$5,$6) RETURNING *", [b.id, c.id, job.id, new Date(jobAt + DAY), shortCode(), new Date(jobAt)]);
      void rr;
      continue;
    }
    if (rand() < 0.08) continue; // a few never asked (e.g. imported)
    const channel = phone ? (rand() < 0.65 ? 'whatsapp' : 'sms') : 'email';
    const sentAt = jobAt + DAY + rand() * 3 * 3600000;
    const openP = { whatsapp: 0.58, sms: 0.39, email: 0.22 }[channel];
    const failed = rand() < 0.03;
    const optout = !failed && rand() < 0.025;
    const opened = !failed && !optout && rand() < openP;
    // Ratings drift upwards over the 90 days (4.5 → 4.8).
    const reviewed = opened && rand() < 0.62;
    const clickAt = sentAt + rand() * 20 * 3600000;
    const reviewAt = clickAt + rand() * 6 * 3600000;
    const status = failed ? 'failed' : reviewed ? 'reviewed' : opened ? 'clicked' : 'delivered';
    const rr = await one(
      `INSERT INTO review_requests (business_id, customer_id, job_id, step, status, channel, send_at, sent_at, delivered_at, clicked_at, reviewed_at, failed_reason, provider_id, link_code, created_at)
       VALUES ($1,$2,$3,'first',$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [b.id, c.id, job.id, status, channel, new Date(sentAt), failed ? null : new Date(sentAt + 4000), opened ? new Date(clickAt) : null, reviewed ? new Date(reviewAt) : null,
        failed ? 'Number not in service' : null, 'demo_' + shortCode(10), shortCode(), new Date(jobAt)]
    );
    await query('UPDATE customers SET last_requested_at = $2 WHERE id = $1', [c.id, new Date(sentAt)]);
    if (failed) {
      await ev('failed', c.id, rr.id, channel, `${label[channel]} to ${c.name} could not be delivered`, 'Carrier error 30005', sentAt + 5000);
      continue;
    }
    await ev('sent', c.id, rr.id, channel, `Review request sent to ${c.name}`, `${label[channel]} · first request · ${ref}`, sentAt);
    if (optout) {
      await query("UPDATE customers SET opted_out = true, opted_out_at = $2, opt_out_reason = 'Replied STOP' WHERE id = $1", [c.id, new Date(sentAt + 3600000)]);
      await ev('opted_out', c.id, rr.id, channel, `${c.name} replied STOP and was opted out`, `${label[channel]} · Replied STOP`, sentAt + 3600000);
      continue;
    }
    // Reminder for those who did not open within 3 days.
    let followClicked = false;
    if (!opened && now - sentAt > 3 * DAY) {
      const fAt = sentAt + 3 * DAY;
      followClicked = rand() < 0.25;
      const fr = await one(
        `INSERT INTO review_requests (business_id, customer_id, job_id, parent_id, step, status, channel, send_at, sent_at, delivered_at, clicked_at, link_code, created_at)
         VALUES ($1,$2,$3,$4,'follow',$5,$6,$7,$7,$7,$8,$9,$10) RETURNING *`,
        [b.id, c.id, job.id, rr.id, followClicked ? 'clicked' : 'delivered', channel, new Date(fAt), followClicked ? new Date(fAt + 7200000) : null, shortCode(), new Date(sentAt)]
      );
      await ev('sent', c.id, fr.id, channel, `Reminder sent to ${c.name}`, `${label[channel]} · reminder`, fAt);
      if (followClicked) {
        await query("UPDATE review_requests SET status = 'clicked', clicked_at = $2 WHERE id = $1", [rr.id, new Date(fAt + 7200000)]);
        await ev('clicked', c.id, fr.id, channel, `${c.name} opened the review link`, `${label[channel]} · reminder`, fAt + 7200000);
      }
    } else if (!opened && now - sentAt <= 3 * DAY) {
      await query("INSERT INTO review_requests (business_id, customer_id, job_id, parent_id, step, status, channel, send_at, link_code, created_at) VALUES ($1,$2,$3,$4,'follow','scheduled',$5,$6,$7,$8)", [b.id, c.id, job.id, rr.id, channel, new Date(sentAt + 3 * DAY), shortCode(), new Date(sentAt)]);
    }
    if (opened) await ev('clicked', c.id, rr.id, channel, `${c.name} opened the review link`, `${label[channel]} · first request`, clickAt);
    if (reviewed) {
      const progress = 1 - ageDays / 92;
      const roll = rand() + progress * 0.18;
      const rating = roll > 0.30 ? 5 : roll > 0.12 ? 4 : roll > 0.05 ? 3 : rand() < 0.5 ? 2 : 1;
      const text = rating === 5 ? pick(GOOD) : rating === 4 ? pick(OK) : pick(MEH);
      const platform = b.facebook_review_url && rand() < 0.2 ? 'facebook' : rand() < 0.82 ? 'google' : 'facebook';
      await query('INSERT INTO reviews (business_id, customer_id, request_id, platform, rating, text, reviewer_name, reviewed_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)', [b.id, c.id, rr.id, platform, rating, text, c.name, new Date(reviewAt)]);
      await ev('reviewed', c.id, rr.id, channel, `${c.name} left a ${rating}-star review on ${platform === 'google' ? 'Google' : 'Facebook'}`, `${label[channel]} · first request`, reviewAt);
    }
  }
  // Older reviews from before NorthStar, so the all-time average has history.
  for (let i = 0; i < 40; i++) {
    const at = now - (95 + rand() * 300) * DAY;
    const rating = rand() < 0.62 ? 5 : rand() < 0.75 ? 4 : rand() < 0.6 ? 3 : 2;
    await query('INSERT INTO reviews (business_id, platform, rating, text, reviewer_name, reviewed_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$6)', [b.id, rand() < 0.8 ? 'google' : 'facebook', rating, rating >= 4 ? pick(GOOD) : pick(MEH), `${pick(FIRST)} ${pick(LAST)[0]}.`, new Date(at)]);
  }
  await ev('system', null, null, null, 'Demo data created', '', now - 93 * DAY);
  console.log(`Demo ready. Sign in as ${EMAIL} / ${PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
