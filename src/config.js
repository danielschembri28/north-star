// Central configuration. Every setting comes from environment variables so the
// same code runs locally, in tests and in production.
import { existsSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: int(env.PORT, 3000),
  baseUrl: (env.BASE_URL
    || (env.CODESPACE_NAME ? `https://${env.CODESPACE_NAME}-${int(env.PORT, 3000)}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}` : '')
    || (env.RENDER_EXTERNAL_URL || '')
    || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/northstar',
  databaseSsl: bool(env.DATABASE_SSL, false),
  appSecret: env.APP_SECRET || (isProd ? '' : 'dev-only-secret-change-me-dev-only-secret'),
  // "console" logs every message instead of sending it, and marks it delivered.
  // "live" sends through Twilio and your email provider.
  messageMode: env.MESSAGE_MODE || (isProd ? 'live' : 'console'),
  engineIntervalSeconds: int(env.ENGINE_INTERVAL_SECONDS, 30),
  runEngine: bool(env.RUN_ENGINE, true),
  // For hosts that sleep when idle (e.g. Render's free plan): an outside scheduler
  // calls /cron/run?key=CRON_SECRET every 10–15 minutes to wake the app and send.
  cronSecret: env.CRON_SECRET || '',
  signupsOpen: bool(env.SIGNUPS_OPEN, true),
  defaultTimezone: env.DEFAULT_TIMEZONE || 'Europe/Malta',
  defaultMonthlyMessages: int(env.DEFAULT_MONTHLY_MESSAGES, 500),

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    smsFrom: env.TWILIO_SMS_FROM || '',
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || '',
    whatsappFrom: env.TWILIO_WHATSAPP_FROM || '',
    whatsappContentSidFirst: env.TWILIO_WHATSAPP_CONTENT_SID_FIRST || '',
    whatsappContentSidFollow: env.TWILIO_WHATSAPP_CONTENT_SID_FOLLOW || '',
    validateWebhooks: bool(env.TWILIO_VALIDATE_WEBHOOKS, isProd)
  },

  email: {
    from: env.EMAIL_FROM || 'NorthStar <reviews@example.com>',
    resendApiKey: env.RESEND_API_KEY || '',
    smtpUrl: env.SMTP_URL || ''
  },

  xero: {
    clientId: env.XERO_CLIENT_ID || '',
    clientSecret: env.XERO_CLIENT_SECRET || '',
    webhookKey: env.XERO_WEBHOOK_KEY || '',
    scopes: env.XERO_SCOPES || 'openid profile email offline_access accounting.invoices.read accounting.contacts.read'
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || ''
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    priceId: env.STRIPE_PRICE_ID || '',
    planName: env.PLAN_NAME || 'Growth',
    planPriceLabel: env.PLAN_PRICE_LABEL || '',
    planMonthlyMessages: int(env.PLAN_MONTHLY_MESSAGES, 500)
  }
};

export const providers = {
  smsReady: () => config.messageMode === 'console' || (!!config.twilio.accountSid && !!config.twilio.authToken && (!!config.twilio.smsFrom || !!config.twilio.messagingServiceSid)),
  whatsappReady: () => config.messageMode === 'console' || (!!config.twilio.accountSid && !!config.twilio.authToken && !!config.twilio.whatsappFrom),
  emailReady: () => config.messageMode === 'console' || !!config.email.resendApiKey || !!config.email.smtpUrl,
  xeroReady: () => !!config.xero.clientId && !!config.xero.clientSecret,
  googleReady: () => !!config.google.clientId && !!config.google.clientSecret,
  stripeReady: () => !!config.stripe.secretKey && !!config.stripe.priceId
};

export function assertConfig() {
  if (config.isProd) {
    if (!config.appSecret || config.appSecret.length < 32) {
      throw new Error('APP_SECRET must be set to a random string of at least 32 characters in production.');
    }
    if (!process.env.BASE_URL && !process.env.RENDER_EXTERNAL_URL) throw new Error('BASE_URL must be set in production (e.g. https://app.yourdomain.com).');
  }
}
