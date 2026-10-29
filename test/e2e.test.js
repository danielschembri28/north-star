import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { startApp, Client, pool } = await import('./helpers.js');
const engine = await import('../src/lib/engine.js');
const { outbox } = await import('../src/lib/providers.js');

let app;
let owner;
const q = async (sql, params) => (await pool.query(sql, params)).rows;

before(async () => { app = await startApp(); owner = new Client(app.base); });
after(async () => { await app.close(); });

const lastMessage = () => outbox[outbox.length - 1];
const codeFrom = (body) => /\/r\/([A-Za-z0-9]+)/.exec(body)[1];

test('sign up lands on onboarding', async () => {
  const page = await owner.get('/signup');
  assert.equal(page.status, 200);
  const r = await owner.post('/signup', { name: 'Mark Vella', business: 'Harbourline Plumbing', email: 'mark@harbourline.mt', password: 'correct horse battery' });
  assert.equal(r.status, 200);
  assert.match(r.url, /\/onboarding$/);
  assert.match(r.text, /Tell us about your business/);
});

test('sign-up validation and duplicate email', async () => {
  const c = new Client(app.base);
  await c.get('/signup');
  const short = await c.post('/signup', { name: 'A', business: 'B', email: 'x@y.com', password: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.text, /at least 10 characters/);
  const dup = await c.post('/signup', { name: 'A', business: 'B', email: 'mark@harbourline.mt', password: 'long enough password' });
  assert.match(dup.text, /already exists/);
});

test('onboarding wizard saves every step and goes live', async () => {
  // Step 1 is multipart; send it as urlencoded with the token in the query, which the route also accepts.
  let r = await owner.request('POST', `/onboarding/1?_csrf=${encodeURIComponent(owner.csrf)}`, { form: { name: 'Harbourline Plumbing', google_review_url: 'g.page/r/harbourline/review', facebook_review_url: '' } });
  assert.match(r.text, /Connect the app you already use/);
  r = await owner.post('/onboarding/2', { app: 'webhook' });
  assert.match(r.text, /Bring in your customers/);
  r = await owner.post('/onboarding/3', {});
  assert.match(r.text, /When should we ask for a review/);
  r = await owner.post('/onboarding/4', { trigger: 'complete' });
  r = await owner.post('/onboarding/5', { delay: '1440' });
  assert.match(r.text, /Choose how to reach customers/);
  r = await owner.post('/onboarding/6', { whatsapp: '1', sms: '1', email: '1' });
  r = await owner.post('/onboarding/7', { follow: '1', wait: '3' });
  assert.match(r.text, /Ready to collect reviews/);
  assert.match(r.text, /Turn on automation/);
  r = await owner.post('/onboarding/8', {});
  assert.match(r.text, /You are live/);
  const [b] = await q('SELECT * FROM businesses');
  assert.equal(b.automation_running, true);
  assert.equal(b.onboarding_done, true);
  assert.equal(b.trigger_type, 'complete');
  assert.equal(b.google_review_url, 'https://g.page/r/harbourline/review');
  // Make tests independent of the clock: no quiet hours, Sundays allowed.
  r = await owner.post('/settings/sending', { daily_limit: '50', quiet_start: '00:00', quiet_end: '00:00', timezone: 'Europe/Malta', repeat_guard: '1', repeat_guard_days: '90' });
  assert.match(r.text, /Sending rules saved/);
});

test('every screen renders', async () => {
  const pages = ['/dashboard', '/dashboard?range=7', '/dashboard?range=90', '/customers', '/customers/new', '/customers/import',
    '/automation', '/automation?step=delay', '/automation?step=message', '/automation?step=wait', '/automation?step=follow',
    '/messages', '/messages?channel=sms', '/messages?channel=email&which=follow', '/activity', '/reviews', '/integrations',
    '/integrations?filter=CRM', '/integrations/webhook', '/integrations/webhook?app=QuickBooks', '/settings', '/menu', '/businesses', '/onboarding?step=3'];
  for (const p of pages) {
    const r = await owner.get(p);
    assert.equal(r.status, 200, `${p} returned ${r.status}`);
    assert.doesNotMatch(r.text, /Something went wrong/, p);
  }
  const missing = await owner.get('/nope');
  assert.equal(missing.status, 404);
});

test('add a customer and send a request now (WhatsApp first)', async () => {
  const before = outbox.length;
  const r = await owner.post('/customers', { name: 'Maria Borg', phone: '7912 4410', email: 'maria@example.com', service: 'boiler repair', reference: 'INV-1042', send: '1' });
  assert.match(r.text, /Review request sent to Maria Borg/);
  assert.equal(outbox.length, before + 1);
  const m = lastMessage();
  assert.equal(m.channel, 'whatsapp');
  assert.equal(m.to, '+35679124410');
  assert.match(m.body, /Hi Maria, thanks for choosing Harbourline Plumbing for your boiler repair/);
  const [rr] = await q("SELECT * FROM review_requests WHERE step = 'first'");
  assert.equal(rr.status, 'delivered');
  const follow = await q("SELECT * FROM review_requests WHERE step = 'follow'");
  assert.equal(follow.length, 1, 'a reminder is scheduled');
  assert.equal(follow[0].channel, 'whatsapp');
});

test('link previews are not clicks; a real tap is, and goes to Google', async () => {
  const code = codeFrom(lastMessage().body);
  const bot = await fetch(`${app.base}/r/${code}`, { headers: { 'user-agent': 'WhatsApp/2.23.20 A' }, redirect: 'manual' });
  assert.equal(bot.status, 302);
  let [rr] = await q("SELECT * FROM review_requests WHERE link_code = $1", [code]);
  assert.equal(rr.clicked_at, null);
  const human = await fetch(`${app.base}/r/${code}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'manual' });
  assert.equal(human.status, 302);
  assert.equal(human.headers.get('location'), 'https://g.page/r/harbourline/review');
  [rr] = await q("SELECT * FROM review_requests WHERE link_code = $1", [code]);
  assert.equal(rr.status, 'clicked');
  const list = await owner.get('/customers?status=Clicked');
  assert.match(list.text, /Maria Borg/);
});

test('clicking cancels the reminder', async () => {
  await q("UPDATE review_requests SET send_at = now() - interval '1 minute' WHERE step = 'follow'");
  const before = outbox.length;
  await engine.tick();
  assert.equal(outbox.length, before, 'no reminder sent');
  const [f] = await q("SELECT status FROM review_requests WHERE step = 'follow'");
  assert.equal(f.status, 'cancelled');
});

test('a review links back to the customer and shows the celebration', async () => {
  const [c] = await q("SELECT id FROM customers WHERE name = 'Maria Borg'");
  const r = await owner.post('/reviews', { customer_id: c.id, reviewer_name: '', platform: 'google', rating: '5', text: 'Fixed our leaking boiler the same afternoon.', date: new Date().toISOString().slice(0, 10) });
  assert.match(r.text, /linked to the request/);
  const [rr] = await q("SELECT status FROM review_requests WHERE customer_id = $1 AND step = 'first'", [c.id]);
  assert.equal(rr.status, 'reviewed');
  const dash = await owner.get('/dashboard');
  assert.match(dash.text, /Your first review is in!/);
  assert.match(dash.text, /Fixed our leaking boiler/);
  await owner.post('/dashboard/celebrated', { to: 'dashboard' });
  const again = await owner.get('/dashboard');
  assert.doesNotMatch(again.text, /Your first review is in!/);
  assert.match(again.text, /Requests sent/);
});

test('webhook job waits for the delay, then sends, then reminds on the same channel', async () => {
  const [b] = await q('SELECT webhook_key FROM businesses');
  const res = await fetch(`${app.base}/webhooks/inbound/${b.webhook_key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Paul Galea', email: 'paul@example.com', service: 'water heater install', reference: 'INV-1044', job_id: 'J-1' })
  });
  assert.equal(res.status, 202);
  const out = await res.json();
  assert.equal(out.request, 'scheduled');
  // Same job again is ignored.
  const dup = await (await fetch(`${app.base}/webhooks/inbound/${b.webhook_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Paul Galea', email: 'paul@example.com', job_id: 'J-1' }) })).json();
  assert.equal(dup.request, 'skipped');

  const before = outbox.length;
  await engine.tick();
  assert.equal(outbox.length, before, 'not sent before the 1 day delay');
  await q("UPDATE review_requests SET send_at = now() - interval '1 minute' WHERE status = 'scheduled'");
  await engine.tick();
  const m = lastMessage();
  assert.equal(m.channel, 'email', 'no phone, so email');
  assert.equal(m.to, 'paul@example.com');
  assert.match(m.subject, /How did we do, Paul\?/);
  assert.match(m.html, /Leave a review/);
  assert.match(m.html, /Unsubscribe/);
  await q("UPDATE review_requests SET send_at = now() - interval '1 minute' WHERE step = 'follow' AND status = 'scheduled'");
  await engine.tick();
  assert.equal(lastMessage().channel, 'email');
  assert.match(lastMessage().subject, /quick favour/);
  const act = await owner.get('/activity');
  assert.match(act.text, /Reminder sent to Paul Galea/);
});

test('the 90-day rule stops asking the same customer twice', async () => {
  const [b] = await q('SELECT webhook_key FROM businesses');
  const out = await (await fetch(`${app.base}/webhooks/inbound/${b.webhook_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Paul Galea', email: 'paul@example.com', job_id: 'J-2' }) })).json();
  assert.equal(out.request, 'skipped');
  const act = await owner.get('/activity?status=Skipped');
  assert.match(act.text, /Did not ask Paul Galea again/);
});

test('pausing holds new jobs; resuming releases them', async () => {
  let r = await owner.post('/automation/toggle', {});
  assert.match(r.text, /Automation is paused/);
  const [b] = await q('SELECT webhook_key, automation_running FROM businesses');
  assert.equal(b.automation_running, false);
  const out = await (await fetch(`${app.base}/webhooks/inbound/${b.webhook_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rita Zammit', phone: '+356 7720 5531', job_id: 'J-3' }) })).json();
  assert.equal(out.request, 'held');
  const dash = await owner.get('/dashboard');
  assert.match(dash.text, /1 finished job is waiting/);
  r = await owner.post('/automation/toggle', {});
  assert.match(r.text, /1 waiting requests will go out shortly|Automation is running/);
  const [rr] = await q("SELECT status FROM review_requests rr JOIN customers c ON c.id = rr.customer_id WHERE c.name = 'Rita Zammit'");
  assert.equal(rr.status, 'scheduled');
});

test('quiet hours hold a message until morning', async () => {
  await owner.post('/settings/sending', { daily_limit: '50', quiet_start: '00:00', quiet_end: '23:59', timezone: 'Europe/Malta', skip_sundays: '', repeat_guard: '1', repeat_guard_days: '90' });
  await q("UPDATE review_requests SET send_at = now() - interval '1 minute' WHERE status = 'scheduled'");
  const before = outbox.length;
  await engine.tick();
  assert.equal(outbox.length, before);
  const act = await owner.get('/activity?status=Scheduled');
  assert.match(act.text, /held: quiet hours/);
  await owner.post('/settings/sending', { daily_limit: '50', quiet_start: '00:00', quiet_end: '00:00', timezone: 'Europe/Malta', repeat_guard: '1', repeat_guard_days: '90' });
  await q("UPDATE review_requests SET send_at = now() - interval '1 minute' WHERE status = 'scheduled'");
  await engine.tick();
  assert.equal(lastMessage().channel, 'whatsapp');
  assert.equal(lastMessage().to, '+35677205531');
});

test('replying STOP opts the customer out', async () => {
  const res = await fetch(`${app.base}/webhooks/twilio/inbound`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: 'whatsapp:+35677205531', Body: 'STOP' }) });
  assert.equal(res.status, 200);
  const [c] = await q("SELECT opted_out FROM customers WHERE name = 'Rita Zammit'");
  assert.equal(c.opted_out, true);
  const list = await owner.get('/customers?status=Opted%20out');
  assert.match(list.text, /Rita Zammit/);
  const [rid] = await q("SELECT id FROM customers WHERE name = 'Rita Zammit'");
  const send = await owner.post(`/customers/${rid.id}/send`, {});
  assert.match(send.text, /has opted out/);
});

test('delivery receipts and failures from Twilio', async () => {
  const [rr] = await q("SELECT * FROM review_requests WHERE step = 'first' AND channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1");
  await q("UPDATE review_requests SET status = 'sent', delivered_at = NULL WHERE id = $1", [rr.id]);
  await fetch(`${app.base}/webhooks/twilio/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ MessageSid: rr.provider_id, MessageStatus: 'delivered' }) });
  const [after] = await q('SELECT status, delivered_at FROM review_requests WHERE id = $1', [rr.id]);
  assert.equal(after.status, 'delivered');
  assert.ok(after.delivered_at);
});

test('email unsubscribe link (one-click)', async () => {
  const [rr] = await q("SELECT rr.link_code FROM review_requests rr JOIN customers c ON c.id = rr.customer_id WHERE c.name = 'Paul Galea' LIMIT 1");
  const page = await fetch(`${app.base}/u/${rr.link_code}`);
  assert.match(await page.text(), /Stop review requests/);
  const res = await fetch(`${app.base}/u/${rr.link_code}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(res.status, 200);
  const [c] = await q("SELECT opted_out FROM customers WHERE name = 'Paul Galea'");
  assert.equal(c.opted_out, true);
});

test('CSV import with column matching', async () => {
  const csv = 'First Name,Last Name,Mobile,E-mail,Service,Invoice #,Date\nSarah,Micallef,79883365,sarah.m@email.com,Blocked drain,INV-1050,29/10/2026\nKevin,Attard,,kevin@email.com,Tap replacement,INV-1031,24/10/2026\nNo Contact,,,,,,\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'list.csv');
  const res = await fetch(`${app.base}/customers/import?_csrf=${encodeURIComponent(owner.csrf)}`, { method: 'POST', headers: { cookie: owner.cookieHeader() }, body: form, redirect: 'manual' });
  assert.equal(res.status, 302);
  const mapPage = await owner.get(res.headers.get('location'));
  assert.match(mapPage.text, /Match your columns/);
  assert.match(mapPage.text, /3 rows found/);
  const id = /\/customers\/import\/([0-9a-f-]+)"/.exec(mapPage.text)[1];
  const r = await owner.post(`/customers/import/${id}`, { name: '', first: '0', last: '1', phone: '2', email: '3', service: '4', reference: '5', date: '6' });
  assert.match(r.text, /2 customers imported, 1 rows skipped/);
  const [s] = await q("SELECT * FROM customers WHERE name = 'Sarah Micallef'");
  assert.equal(s.phone, '+35679883365');
  const jobs = await q('SELECT * FROM jobs WHERE customer_id = $1', [s.id]);
  assert.equal(jobs[0].reference, 'INV-1050');
  assert.equal(new Date(jobs[0].completed_at).getUTCMonth(), 9);
  const none = await q("SELECT count(*)::int AS n FROM review_requests rr JOIN customers c ON c.id = rr.customer_id WHERE c.name = 'Sarah Micallef'");
  assert.equal(none[0].n, 0, 'imported customers are not messaged');
});

test('message templates save and test-send', async () => {
  let r = await owner.post('/messages', { channel: 'sms', which: 'first', subject: '', body: 'Hi {first_name}! Rate {business_name}: {review_link}' });
  assert.match(r.text, /Message saved/);
  assert.match(r.text, /Hi {first_name}! Rate {business_name}/);
  r = await owner.post('/messages/test', { channel: 'sms', which: 'first', to: '79000000' });
  assert.match(r.text, /Test text sent to \+35679000000/);
  assert.match(lastMessage().body, /Hi Mark! Rate Harbourline Plumbing: .* Reply STOP to opt out$/);
});

test('team invite, accept as view-only, and permissions are enforced', async () => {
  const r = await owner.post('/settings/team/invite', { email: 'ryan@harbourline.mt', role: 'viewer' });
  const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(r.text)[1];
  const ryan = new Client(app.base);
  const page = await ryan.get(`/invite/${link}`);
  assert.match(page.text, /Join Harbourline Plumbing/);
  const acc = await ryan.post(`/invite/${link}`, { name: 'Ryan Caruana', password: 'another long password' });
  assert.match(acc.url, /\/dashboard/);
  const blocked = await ryan.post('/customers', { name: 'X', phone: '79111111' });
  assert.match(blocked.text, /view only/);
  const count = await q("SELECT count(*)::int AS n FROM customers WHERE name = 'X'");
  assert.equal(count[0].n, 0);
  const settings = await ryan.get('/settings');
  assert.doesNotMatch(settings.text, /Invite someone/);
});

test('CSRF protection rejects forged posts', async () => {
  const res = await fetch(`${app.base}/automation/toggle`, { method: 'POST', headers: { cookie: owner.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(res.status, 403);
});

test('webhook signatures are checked', async () => {
  const bad = await fetch(`${app.base}/webhooks/xero`, { method: 'POST', headers: { 'x-xero-signature': 'nope' }, body: '{"events":[]}' });
  assert.equal(bad.status, 401);
  const body = '{"events":[],"firstEventSequence":0,"lastEventSequence":0,"entropy":"X"}';
  const sig = createHmac('sha256', 'test-xero-key').update(body).digest('base64');
  const good = await fetch(`${app.base}/webhooks/xero`, { method: 'POST', headers: { 'x-xero-signature': sig }, body });
  assert.equal(good.status, 200);
  const stripe = await fetch(`${app.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  assert.equal(stripe.status, 400);
});

test('second business, switching, and sign out', async () => {
  let r = await owner.post('/businesses', { name: 'Harbourline Gas' });
  assert.match(r.url, /onboarding/);
  r = await owner.get('/businesses');
  assert.match(r.text, /Harbourline Gas/);
  assert.match(r.text, /Harbourline Plumbing/);
  const [b1] = await q("SELECT id FROM businesses WHERE name = 'Harbourline Plumbing'");
  r = await owner.post(`/businesses/${b1.id}/switch`, {});
  assert.match(r.text, /Harbourline Plumbing/);
  r = await owner.post('/logout', {});
  assert.match(r.url, /\/login/);
  const after = await owner.get('/dashboard');
  assert.match(after.url, /\/login/);
});

test('wake-up endpoint for free hosting needs the key and sends due messages', async () => {
  const bad = await fetch(`${app.base}/cron/run?key=wrong`);
  assert.equal(bad.status, 401);
  const res = await fetch(`${app.base}/cron/run?key=cron-test-key`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.errors, []);
});
