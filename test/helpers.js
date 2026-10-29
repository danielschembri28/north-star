// Test harness: a fresh database, the real app on a random port, and a tiny
// browser-like client with a cookie jar.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/northstar_test';
process.env.MESSAGE_MODE = 'console';
process.env.RUN_ENGINE = 'false';
process.env.XERO_WEBHOOK_KEY = 'test-xero-key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.CRON_SECRET = 'cron-test-key';
process.env.PORT = '0';

const { pool, migrate } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

export async function startApp() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  return { base, close: async () => { server.close(); await pool.end(); } };
}

export class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.csrf = ''; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      const val = v.join('=');
      if (!val || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = val;
    }
  }
  async request(method, path, { form, json, headers = {}, follow = true, raw } = {}) {
    let url = path.startsWith('http') ? path : this.base + path;
    let body;
    const h = { cookie: this.cookieHeader(), ...headers };
    if (form) {
      const f = { _csrf: this.csrf, ...form };
      body = new URLSearchParams(f).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (json) {
      body = JSON.stringify(json);
      h['content-type'] = 'application/json';
    } else if (raw) {
      body = raw;
    }
    let res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
    this.store(res);
    let hops = 0;
    while (follow && [301, 302, 303].includes(res.status) && hops++ < 10) {
      const loc = res.headers.get('location');
      if (!loc.startsWith('/') && !loc.startsWith(this.base)) break;
      url = loc.startsWith('/') ? this.base + loc : loc;
      res = await fetch(url, { headers: { cookie: this.cookieHeader() }, redirect: 'manual' });
      this.store(res);
    }
    const text = await res.text();
    const m = /name="csrf-token" content="([^"]*)"/.exec(text);
    if (m && m[1]) this.csrf = m[1];
    return { status: res.status, text, url, headers: res.headers };
  }
  get(path, opts) { return this.request('GET', path, opts); }
  post(path, form, opts = {}) { return this.request('POST', path, { form, ...opts }); }
}

export { pool };
