# NorthStar

Automated review requests for small businesses. When a job is finished or an invoice is paid, NorthStar waits a little, then asks the customer for a Google or Facebook review by WhatsApp, SMS or email, sends one friendly reminder, and tracks every send, click and review.

This is the working version of the **NorthStar App Design** canvas: every screen in the design is a real page backed by a database.

---

## What's in it

| Area | What works |
|---|---|
| **Accounts** | Sign up, sign in, password reset, team invites with Owner / Manager / View only roles, several businesses per login (for agencies) |
| **Onboarding** | The 8-step wizard from the design: business, app, customers, trigger, timing, channels, reminder, go live |
| **Sending engine** | Delay after each job, quiet hours (per time zone, DST-safe), no Sundays, daily limit, monthly allowance, "once every 90 days" rule, channel fallback (WhatsApp → SMS → email), one reminder on the same channel, retries, pause/resume with a waiting queue |
| **Channels** | Twilio SMS, Twilio WhatsApp (Meta-approved templates), email through Resend or any SMTP server, with a branded HTML email and one-click unsubscribe |
| **Review link** | Short link per request (`/r/abc1234`) that records the click (ignoring WhatsApp/iMessage link previews) and goes straight to Google, or lets the customer choose Google or Facebook |
| **Opt-outs** | STOP replies by SMS/WhatsApp, email unsubscribe link (RFC 8058), manual opt-out. Opted-out customers are never messaged again |
| **Integrations** | Xero (OAuth, paid-invoice webhooks + polling fallback, contact import), Google Business Profile (pull reviews in, match them to customers, reply), generic webhook for Zapier / Make / n8n (QuickBooks, Fresha, Square, Jobber, HubSpot, Pipedrive…), CSV import with column matching |
| **Screens** | Dashboard (KPIs with period deltas, rating trend, funnel, channels, recent reviews), Customers (search, filters, paging, detail and history, export), Automation builder, Message templates with live preview and SMS counter, Activity log with CSV export, Reviews (breakdown, filters, reply, add by hand), Integrations, Settings, empty / paused / error / syncing / first-review celebration states, phone layout |
| **Billing (optional)** | Stripe Checkout subscription, customer portal, plan allowance |
| **Security** | scrypt passwords, server-side sessions, CSRF tokens, strict Content Security Policy, encrypted OAuth tokens, signature checks on Twilio / Xero / Stripe webhooks, rate-limited sign-in |

---

## Try it on your computer (5 minutes)

You need **Node.js 20.12+** and **PostgreSQL 14+** (or Docker).

**With Docker:**
```bash
docker compose up --build
# in another terminal, load the demo business:
docker compose exec app node scripts/seed-demo.js
```

**Without Docker:**
```bash
npm install
createdb northstar                       # or create it in your Postgres app
DATABASE_URL=postgres://localhost/northstar npm run seed:demo
DATABASE_URL=postgres://localhost/northstar npm start
```

Open http://localhost:3000 and sign in as **demo@northstar.app / northstar-demo** (a plumbing business with 90 days of history), or create a new account to walk through onboarding.

Locally, `MESSAGE_MODE` defaults to `console`: nothing is really sent. Each message is printed in the terminal and marked delivered, so you can follow the whole flow, open the `/r/…` links and watch the dashboard update.

Run the tests (they use a separate database called `northstar_test`):
```bash
createdb northstar_test
npm test
```

---

## Run it for free

### Option A — try it in GitHub Codespaces (for testing and demos)
1. On the repo page: **Code → Codespaces → Create codespace on main**.
2. Wait a few minutes while it installs and loads the demo business. A browser tab opens with NorthStar (if not, open the **Ports** tab and click the globe next to port 3000).
3. Sign in as **demo@northstar.app / northstar-demo**.

GitHub Free includes 120 core-hours a month (about 60 hours on the default 2-core machine). A codespace stops after 30 minutes without use, so it is not a live service for customers. Messages are only logged (test mode).

### Option B — live on the internet, free (Render + Neon + cron-job.org)
No credit card needed for any of the three.

1. **Database — Neon.** Sign up at [neon.com](https://neon.com), create a project in **Europe (Frankfurt)**, and copy the connection string (`postgresql://…?sslmode=require`).
2. **App — Render.** Sign up at [render.com](https://render.com) with your GitHub account. **New → Blueprint**, pick this repo; Render reads `render.yaml` and creates a free web service in Frankfurt. When asked for `DATABASE_URL`, paste the Neon string. Deploy, then open the address it gives you (e.g. `https://northstar-xxxx.onrender.com`) and create your account.
3. **Wake-up timer — cron-job.org.** Render's free service sleeps after 15 minutes without visitors, which would pause sending. At [cron-job.org](https://cron-job.org) create a free job that opens
   `https://YOUR-APP.onrender.com/cron/run?key=YOUR_CRON_SECRET`
   **every 15 minutes** (copy `CRON_SECRET` from the service's Environment tab in Render). Each call sends whatever is due and syncs Xero and Google.

What to expect on the free setup:
- The first page you open after a quiet spell takes about a minute to load while the app wakes up.
- Messages go out within about 15 minutes of when they are due, instead of within 30 seconds.
- Neon's free plan gives 1 GB of storage and 100 compute-hours a month, enough for thousands of customers; Render gives 750 hours and 5 GB of traffic a month. Calling the timer more often than every 15 minutes can use up Neon's hours.
- Sending real messages still costs money per message through Twilio (SMS and WhatsApp). Email providers such as Resend have free tiers.

When you have paying customers, move the Render service to a paid instance (about $7 a month) so it never sleeps, set `RUN_ENGINE=true`, and delete the cron job. Don't use Render's own free Postgres: it is deleted 30 days after you create it.

## Put it online (Railway, about 20 minutes)

Railway is the simplest host for this app because NorthStar is one always-on process (the sending engine runs inside it) plus Postgres. Render, Fly.io, a VPS or any Docker host work the same way.

1. Put this folder in a GitHub repository (private is fine).
2. At [railway.com](https://railway.com): **New project → Deploy from GitHub repo** → pick the repo. Railway reads `railway.json` and builds the Dockerfile.
3. In the project: **New → Database → PostgreSQL**.
4. Open the NorthStar service → **Variables** and add:
   - `DATABASE_URL` → reference the Postgres service's `DATABASE_URL`
   - `DATABASE_SSL` = `false` on Railway's private network (use `true` with Neon, Supabase etc.)
   - `NODE_ENV` = `production`
   - `APP_SECRET` = output of `openssl rand -hex 32`
   - `BASE_URL` = your public address (next step)
   - `MESSAGE_MODE` = `console` for now
5. **Settings → Networking → Generate domain** (or add your own, e.g. `app.northstar.mt`, and point a CNAME at it). Put that address in `BASE_URL`, including `https://`.
6. Deploy. The database tables are created automatically on start. Open the address, create your account, and finish onboarding.
7. When the providers below are set up, change `MESSAGE_MODE` to `live`.

Keep the app at **one instance** (the engine also guards against double-sending with row locks, but one is all a small SaaS needs). Back up the database (Railway has scheduled backups on paid plans).

---

## Connect the providers

Every provider is optional. A channel or integration that isn't configured shows as "Not set up on the server" and is skipped.

### Twilio SMS
1. Create a Twilio account, buy a number or register an alphanumeric sender (in Malta and most of Europe an alphanumeric sender like `Harbourline` works for one-way SMS).
2. Create a **Messaging Service**, add the sender, and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`.
3. In the Messaging Service → Integration, set **Incoming messages** to webhook `https://YOUR_APP/webhooks/twilio/inbound`. Delivery receipts go to `/webhooks/twilio/status` automatically.

### Twilio WhatsApp
WhatsApp only allows businesses to start a conversation with a **template approved by Meta**.
1. In Twilio, register a WhatsApp sender (needs a Meta Business account) and set `TWILIO_WHATSAPP_FROM`.
2. In **Content Template Builder**, create a template with a URL button or text containing four variables, for example:
   *Hi {{1}}, thanks for choosing {{2}} for your {{3}}. Would you leave us a quick review? {{4}}*
   Submit it for WhatsApp approval (category *Utility* or *Marketing*). Do the same for the reminder.
3. Put the approved `HX…` SIDs in `TWILIO_WHATSAPP_CONTENT_SID_FIRST` and `TWILIO_WHATSAPP_CONTENT_SID_FOLLOW`.
4. Point the sender's incoming webhook at `/webhooks/twilio/inbound` so STOP replies are recorded.

The wording on the Messages screen is used for previews and for the Twilio sandbox; the live WhatsApp text comes from the approved template.

### Email
Either **Resend** (`RESEND_API_KEY`, verify your sending domain there) or any SMTP provider (`SMTP_URL`, e.g. Postmark, Brevo, Amazon SES). Set `EMAIL_FROM` to an address on the verified domain. Emails go out "from" each business's name at that address.

### Xero
1. At [developer.xero.com](https://developer.xero.com/app/manage) create a **Web app**. Redirect URI: `https://YOUR_APP/integrations/xero/callback`. Set `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`.
2. Under **Webhooks**, subscribe to *Invoices*, delivery URL `https://YOUR_APP/webhooks/xero`, and copy the webhook key to `XERO_WEBHOOK_KEY`. Xero sends an "intent to receive" check; NorthStar answers it.
3. Apps created after 2 March 2026 must use Xero's granular scopes; the default `XERO_SCOPES` already does. Even without webhooks, NorthStar polls Xero every 10 minutes for newly paid invoices.
4. To let other businesses connect their Xero (not just yours), the app must pass Xero's certification once you go past their uncertified-app connection limit.

### Google Business Profile (review sync and replies)
1. In Google Cloud, create a project, enable the **My Business Account Management**, **My Business Business Information** and **Google My Business** APIs, and **request access** to the Business Profile APIs (Google reviews this; it can take a few days).
2. Create an OAuth client (Web), redirect URI `https://YOUR_APP/integrations/google/callback`, and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Publish the OAuth consent screen with the `business.manage` scope.
3. Connected businesses get their Google reviews pulled in every 30 minutes, matched to the customers who were asked, and can reply from the Reviews page.

Without this, reviews can be logged by hand on the Reviews page (Facebook reviews are always added this way: Meta's API doesn't offer page reviews to apps like this).

### Zapier / Make (QuickBooks, Fresha, Square, HubSpot…)
Each business has a private webhook address on **Integrations → Zapier, Make or your own app**. A Zap with the app's "job done" trigger and a *Webhooks by Zapier → POST* action creates the customer and starts the request. The page shows the exact fields.

### Stripe (optional)
Create a recurring Price, set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `PLAN_NAME`, `PLAN_PRICE_LABEL`, `PLAN_MONTHLY_MESSAGES`. Add a webhook endpoint `https://YOUR_APP/webhooks/stripe` for `checkout.session.completed` and `customer.subscription.*`, and set `STRIPE_WEBHOOK_SECRET`. Turn on the customer portal in Stripe settings. Owners then see **Upgrade** under Settings → Billing.

---

## Webhook addresses at a glance

| Provider | URL |
|---|---|
| Twilio incoming (STOP) | `/webhooks/twilio/inbound` |
| Twilio delivery status | `/webhooks/twilio/status` (set automatically) |
| Xero | `/webhooks/xero` |
| Stripe | `/webhooks/stripe` |
| Zapier / Make / your app | `/webhooks/inbound/<business key>` |
| Health check | `/healthz` |

---

## Before you take paying customers

- **Privacy and GDPR.** You process your customers' customers' phone numbers and emails. Publish a privacy policy and terms, sign a data processing agreement with each business (you are their processor), and list Twilio, your email provider and your host as sub-processors. Customers can be deleted from their page; deleting a business removes all its data.
- **Consent.** Businesses should only import people they have done work for. Every message carries an opt-out, and STOP is honoured across all channels.
- **Review rules.** NorthStar sends every customer to the review site, whatever they might say. Don't add "only ask happy customers" filtering: Google's policies forbid review gating.
- **WhatsApp.** Meta charges per conversation and can pause senders with poor quality ratings. Keep templates friendly and one reminder at most (the default).

---

## How it's built

Plain Node.js (Express 5, server-rendered EJS) and PostgreSQL, with no build step. Pages work without JavaScript; `public/app.js` only adds live previews and conveniences.

```
src/
  server.js            app setup, security headers, routing
  config.js            every setting, from environment variables
  db.js, migrations/   Postgres pool and schema (applied on start)
  lib/engine.js        the sending engine: queue, rules, channels, follow-ups, clicks, reviews, opt-outs
  lib/providers.js     Twilio, Resend/SMTP, console outbox
  lib/xero.js          Xero OAuth, webhooks, polling, import
  lib/google.js        Google Business Profile sync and replies
  lib/stripe.js        billing
  lib/time.js          time zones, quiet hours
  routes/              one file per screen
  views/               templates per screen
public/                styles from the design, small script
scripts/seed-demo.js   demo business
test/                  unit and end-to-end tests
```

The engine checks for due messages every 30 seconds (`ENGINE_INTERVAL_SECONDS`). Set `RUN_ENGINE=false` on any extra web instance if you ever run more than one.
