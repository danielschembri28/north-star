import { many, query } from '../db.js';
import { firstName } from './util.js';

export const TOKENS = ['{first_name}', '{business_name}', '{service}', '{review_link}'];

export const DEFAULT_TEMPLATES = {
  whatsapp: {
    first: { subject: '', body: 'Hi {first_name}, thanks for choosing {business_name} for your {service}. If you were happy with the job, would you leave us a quick review? It takes under a minute: {review_link}' },
    follow: { subject: '', body: 'Hi {first_name}, just a gentle nudge in case our last message got buried. Your review really helps a small business like ours: {review_link}' }
  },
  sms: {
    first: { subject: '', body: 'Hi {first_name}, thanks for choosing {business_name}. Could you leave us a quick review? {review_link} Reply STOP to opt out' },
    follow: { subject: '', body: 'Hi {first_name}, a quick reminder from {business_name}. A short review would mean a lot: {review_link} Reply STOP to opt out' }
  },
  email: {
    first: { subject: 'How did we do, {first_name}?', body: 'Hi {first_name},\n\nThank you for choosing {business_name} for your {service}. If you have a minute, we would love to hear how it went.\n\nYour review helps other people in the area find a business they can trust.' },
    follow: { subject: 'A quick favour, {first_name}?', body: 'Hi {first_name},\n\nJust following up in case our last email slipped past. A short review would really help us.\n\nThank you!' }
  }
};

export async function getTemplates(businessId) {
  const rows = await many('SELECT channel, which, subject, body FROM templates WHERE business_id = $1', [businessId]);
  const out = structuredClone(DEFAULT_TEMPLATES);
  for (const r of rows) out[r.channel][r.which] = { subject: r.subject, body: r.body };
  return out;
}

export async function saveTemplate(businessId, channel, which, subject, body) {
  await query(
    `INSERT INTO templates (business_id, channel, which, subject, body) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (business_id, channel, which) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()`,
    [businessId, channel, which, subject || '', body]
  );
}

export function fillTokens(text, vars) {
  return String(text || '')
    .split('{first_name}').join(vars.first_name)
    .split('{business_name}').join(vars.business_name)
    .split('{service}').join(vars.service)
    .split('{review_link}').join(vars.review_link);
}

// Builds the final text for a channel. Guarantees the link (and, for SMS, the
// opt-out line) is present even if the owner deleted the token.
export function renderMessage(channel, tpl, { customerName, businessName, service, link }) {
  const vars = {
    first_name: firstName(customerName),
    business_name: businessName,
    service: service || 'visit',
    review_link: link
  };
  let body = fillTokens(tpl.body, vars).trim();
  if (channel !== 'email' && !body.includes(link)) body += ' ' + link;
  if (channel === 'sms' && !/\bSTOP\b/i.test(body)) body += ' Reply STOP to opt out';
  const subject = channel === 'email' ? fillTokens(tpl.subject || 'How did we do, {first_name}?', vars) : '';
  return { subject, body, vars };
}

export function smsSegments(text) {
  // GSM-7 messages are 160 chars per text (153 when split); anything with
  // emoji or other Unicode drops to 70 (67 when split).
  const gsm = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const len = [...text].length;
  return { len, single, segments: len <= single ? 1 : Math.ceil(len / multi) };
}
