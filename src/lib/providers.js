// Message delivery: Twilio (SMS + WhatsApp) and email (Resend or SMTP).
// In MESSAGE_MODE=console nothing leaves the server: messages are logged and
// kept in `outbox` so you can try the whole product without any accounts.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { hmac, randomToken, safeEqual } from './crypto.js';

export const outbox = [];
const remember = (m) => {
  outbox.push({ ...m, at: new Date() });
  if (outbox.length > 200) outbox.shift();
};

export class SendError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.permanent = permanent;
  }
}

async function twilioRequest(params) {
  const { accountSid, authToken } = config.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 21211 invalid number, 21610 unsubscribed, 21614 not a mobile, 63016 outside WhatsApp window
    const permanent = [21211, 21610, 21614, 21408, 63003, 63016, 63024].includes(data.code);
    throw new SendError(data.message || `Twilio error ${res.status}`, { permanent });
  }
  return data.sid;
}

export async function sendSms({ to, body }) {
  if (config.messageMode === 'console') {
    console.log(`[console sms] to ${to}: ${body}`);
    const id = 'console_' + randomToken(9);
    remember({ channel: 'sms', to, body, id });
    return id;
  }
  const params = { To: to, Body: body, StatusCallback: `${config.baseUrl}/webhooks/twilio/status` };
  if (config.twilio.messagingServiceSid) params.MessagingServiceSid = config.twilio.messagingServiceSid;
  else params.From = config.twilio.smsFrom;
  return twilioRequest(params);
}

// WhatsApp business-initiated messages must use a Meta-approved template.
// Set TWILIO_WHATSAPP_CONTENT_SID_FIRST / _FOLLOW to your Content Template SIDs;
// variables are {{1}} first name, {{2}} business name, {{3}} service, {{4}} link.
export async function sendWhatsApp({ to, body, step, vars }) {
  if (config.messageMode === 'console') {
    console.log(`[console whatsapp] to ${to}: ${body}`);
    const id = 'console_' + randomToken(9);
    remember({ channel: 'whatsapp', to, body, id });
    return id;
  }
  const from = config.twilio.whatsappFrom.startsWith('whatsapp:') ? config.twilio.whatsappFrom : 'whatsapp:' + config.twilio.whatsappFrom;
  const params = { To: 'whatsapp:' + to, From: from, StatusCallback: `${config.baseUrl}/webhooks/twilio/status` };
  const contentSid = step === 'follow' ? config.twilio.whatsappContentSidFollow || config.twilio.whatsappContentSidFirst : config.twilio.whatsappContentSidFirst;
  if (contentSid && vars) {
    params.ContentSid = contentSid;
    params.ContentVariables = JSON.stringify({ 1: vars.first_name, 2: vars.business_name, 3: vars.service, 4: vars.review_link });
  } else {
    params.Body = body;
  }
  return twilioRequest(params);
}

let smtp = null;
export async function sendEmail({ to, subject, text, html, headers = {}, from }) {
  const sender = from || config.email.from;
  if (config.messageMode === 'console') {
    console.log(`[console email] to ${to}: ${subject}\n${text}`);
    const id = 'console_' + randomToken(9);
    remember({ channel: 'email', to, subject, body: text, html, id });
    return id;
  }
  if (config.email.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [to], subject, text, html, headers })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SendError(data.message || `Email error ${res.status}`, { permanent: res.status === 422 });
    return data.id;
  }
  if (config.email.smtpUrl) {
    smtp ||= nodemailer.createTransport(config.email.smtpUrl);
    const info = await smtp.sendMail({ from: sender, to, subject, text, html, headers });
    return info.messageId;
  }
  throw new SendError('No email provider is configured. Set RESEND_API_KEY or SMTP_URL.');
}

// https://www.twilio.com/docs/usage/security#validating-requests
export function validTwilioSignature(req) {
  if (!config.twilio.validateWebhooks) return true;
  const sig = req.get('x-twilio-signature') || '';
  const url = config.baseUrl + req.originalUrl;
  const params = req.body || {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(sig, hmac('sha1', config.twilio.authToken, data, 'base64'));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reviewEmailHtml({ businessName, logoUrl, body, link, unsubscribeUrl, buttonLabel = 'Leave a review' }) {
  const paras = String(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#101828">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(businessName)}" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:14px;object-fit:cover;margin:0 0 24px">`
    : `<div style="width:56px;height:56px;border-radius:14px;background:#0B1530;color:#F2B630;font:800 20px/56px Arial,sans-serif;text-align:center;margin:0 0 24px">${esc(businessName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</div>`;
  return `<!doctype html><html><body style="margin:0;background:#F4F5F9;padding:32px 16px;font-family:Manrope,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#FFFFFF;border:1px solid #E3E6EE;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="padding:32px">
${logo}${paras}
${link ? `<a href="${esc(link)}" style="display:inline-block;margin:8px 0 8px;padding:14px 24px;border-radius:12px;background:#0B1530;color:#FFFFFF;font-weight:700;font-size:16px;text-decoration:none">${esc(buttonLabel)}</a>` : ''}
</td></tr></table>
${unsubscribeUrl ? `<p style="margin:16px 0 0;font-size:13px;color:#4A5568">Do not want these emails? <a href="${esc(unsubscribeUrl)}" style="color:#2754C5">Unsubscribe in one click</a>.</p>` : ''}
<p style="margin:8px 0 0;font-size:12px;color:#5B6474">Sent on behalf of ${esc(businessName)}</p>
</td></tr></table></body></html>`;
}
