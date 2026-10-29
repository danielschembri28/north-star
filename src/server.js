import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, providers, assertConfig } from './config.js';
import { migrate, many, one } from './db.js';
import { loadSession, requireAuth, verifyCsrf, can, ROLE_LABEL } from './lib/auth.js';
import { startEngine, tick } from './lib/engine.js';
import { startSyncLoops, cleanup } from './lib/sync.js';
import { pollAllXero } from './lib/xero.js';
import { pollAllGoogle } from './lib/google.js';
import { safeEqual } from './lib/crypto.js';
import { helpers } from './lib/view-helpers.js';
import { setupProgress } from './lib/stats.js';

import webhooks from './routes/webhooks.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import onboarding from './routes/onboarding.js';
import dashboard from './routes/dashboard.js';
import customers from './routes/customers.js';
import automation from './routes/automation.js';
import messages from './routes/messages.js';
import activity from './routes/activity.js';
import reviews from './routes/reviews.js';
import integrations from './routes/integrations.js';
import settings from './routes/settings.js';
import billing from './routes/billing.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', join(here, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        formAction: ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com', 'https://login.xero.com', 'https://accounts.google.com'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.baseUrl.startsWith('https://') ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  app.use('/static', express.static(join(here, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Wake-up endpoint for free hosts that sleep: sends due messages and syncs apps.
  app.all('/cron/run', async (req, res) => {
    const key = String(req.query.key || req.get('x-cron-key') || '');
    if (!config.cronSecret || !safeEqual(key, config.cronSecret)) return res.status(401).json({ error: 'Bad key' });
    const started = Date.now();
    const sent = await tick();
    const errors = [];
    for (const [name, fn] of [['xero', pollAllXero], ['google', pollAllGoogle], ['cleanup', cleanup]]) {
      await fn().catch((e) => errors.push(`${name}: ${e.message}`));
    }
    res.json({ ok: true, processed: sent, errors, ms: Date.now() - started });
  });

  // Webhooks need their raw bodies for signature checks, so they come first.
  app.use('/webhooks', webhooks);

  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Block cross-site form posts (defence in depth alongside CSRF tokens).
  const allowedOrigin = new URL(config.baseUrl).origin;
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin');
    if (origin && origin !== 'null' && origin !== allowedOrigin && config.isProd) {
      return res.status(403).send('Cross-site request blocked');
    }
    next();
  });

  app.use(loadSession);
  app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.business = req.business || null;
    res.locals.role = req.role || null;
    res.locals.roleLabel = ROLE_LABEL[req.role] || '';
    res.locals.csrf = req.session?.csrf || '';
    res.locals.flash = req.incomingFlash || [];
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.h = helpers(req.business);
    res.locals.canEdit = can(req, 'manager');
    res.locals.isOwner = can(req, 'owner');
    res.locals.providers = {
      sms: providers.smsReady(), whatsapp: providers.whatsappReady(), email: providers.emailReady(),
      xero: providers.xeroReady(), google: providers.googleReady(), stripe: providers.stripeReady()
    };
    res.locals.messageMode = config.messageMode;
    res.locals.baseUrl = config.baseUrl;
    res.locals.title = 'NorthStar';
    next();
  });

  app.use(publicRoutes);
  app.use(authRoutes);

  // Everything below needs a signed-in user with a business.
  const appRouter = express.Router();
  appRouter.use(requireAuth, verifyCsrf);
  appRouter.use(async (req, res, next) => {
    if (req.method !== 'GET' || !req.business) return next();
    const [progress, memberships, integrationError] = await Promise.all([
      setupProgress(req.business),
      many('SELECT b.id, b.name, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 ORDER BY b.name', [req.user.id]),
      one("SELECT provider, error_message, error_at FROM integrations WHERE business_id = $1 AND status = 'error' ORDER BY error_at DESC LIMIT 1", [req.business.id])
    ]);
    res.locals.progress = progress;
    res.locals.memberships = memberships;
    res.locals.integrationError = integrationError;
    next();
  });
  appRouter.use(onboarding, dashboard, customers, automation, messages, activity, reviews, integrations, settings, billing);
  app.use(appRouter);

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist. It may have been moved or deleted.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    const status = err.status || 500;
    res.status(status).render('error', {
      title: status === 413 ? 'File too large' : 'Something went wrong',
      message: status === 413 ? 'That file is too large. Try one under 5 MB.' : 'Sorry, that did not work. Please try again in a moment.'
    });
  });
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  assertConfig();
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`NorthStar listening on ${config.baseUrl} (port ${config.port})`);
    if (config.runEngine) {
      startEngine();
      startSyncLoops();
    }
  });
}
