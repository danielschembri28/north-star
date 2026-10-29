import { Router } from 'express';
import { query } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { getTemplates, saveTemplate, renderMessage, smsSegments, DEFAULT_TEMPLATES, TOKENS } from '../lib/templates.js';
import { sendSms, sendWhatsApp, sendEmail, reviewEmailHtml } from '../lib/providers.js';
import { emailFrom } from '../lib/engine.js';
import { normalizePhone, isEmail } from '../lib/util.js';
import { config, providers } from '../config.js';

const r = Router();
const CHANNELS = ['whatsapp', 'sms', 'email'];
const SAMPLE = { customerName: 'Maria Borg', service: 'boiler repair' };

r.get('/messages', async (req, res) => {
  const b = req.business;
  const channel = CHANNELS.includes(req.query.channel) ? req.query.channel : 'whatsapp';
  const which = req.query.which === 'follow' ? 'follow' : 'first';
  const templates = await getTemplates(b.id);
  const tpl = templates[channel][which];
  const link = `${config.baseUrl.replace(/^https?:\/\//, '')}/r/hb7Q2xk`;
  const preview = renderMessage(channel, tpl, { ...SAMPLE, businessName: b.name, link });
  res.render('messages', {
    title: 'Messages', active: 'messages', channel, which, tpl, preview, link, tokens: TOKENS,
    seg: smsSegments(preview.body), sample: { first_name: 'Maria', business_name: b.name, service: SAMPLE.service, review_link: link },
    ready: { whatsapp: providers.whatsappReady(), sms: providers.smsReady(), email: providers.emailReady() },
    waTemplate: !!config.twilio.whatsappContentSidFirst
  });
});

r.post('/messages', requireRole('manager'), async (req, res) => {
  const channel = CHANNELS.includes(req.body.channel) ? req.body.channel : 'whatsapp';
  const which = req.body.which === 'follow' ? 'follow' : 'first';
  const body = String(req.body.body || '').trim().slice(0, 1600);
  if (!body) {
    req.flash('error', 'The message cannot be empty.');
    return res.redirect(`/messages?channel=${channel}&which=${which}`);
  }
  await saveTemplate(req.business.id, channel, which, String(req.body.subject || '').slice(0, 200), body);
  await query('UPDATE businesses SET templates_saved = true WHERE id = $1', [req.business.id]);
  req.flash('success', 'Message saved. New requests will use it.');
  res.redirect(`/messages?channel=${channel}&which=${which}`);
});

r.post('/messages/reset', requireRole('manager'), async (req, res) => {
  const channel = CHANNELS.includes(req.body.channel) ? req.body.channel : 'whatsapp';
  const which = req.body.which === 'follow' ? 'follow' : 'first';
  const d = DEFAULT_TEMPLATES[channel][which];
  await saveTemplate(req.business.id, channel, which, d.subject, d.body);
  req.flash('success', 'Restored the suggested wording.');
  res.redirect(`/messages?channel=${channel}&which=${which}`);
});

r.post('/messages/test', requireRole('manager'), async (req, res) => {
  const b = req.business;
  const channel = CHANNELS.includes(req.body.channel) ? req.body.channel : 'whatsapp';
  const which = req.body.which === 'follow' ? 'follow' : 'first';
  const back = `/messages?channel=${channel}&which=${which}`;
  const to = String(req.body.to || '').trim();
  const templates = await getTemplates(b.id);
  const link = b.google_review_url || `${config.baseUrl}/r/test`;
  const msg = renderMessage(channel, templates[channel][which], { customerName: req.user.name, businessName: b.name, service: SAMPLE.service, link });
  try {
    if (channel === 'email') {
      const addr = isEmail(to) ? to : req.user.email;
      await sendEmail({ to: addr, subject: '[Test] ' + msg.subject, text: msg.body + '\n\n' + link, html: reviewEmailHtml({ businessName: b.name, logoUrl: b.logo_file_id ? `${config.baseUrl}/files/${b.logo_file_id}` : '', body: msg.body, link }), from: emailFrom(b) });
      req.flash('success', `Test email sent to ${addr}.`);
    } else {
      const phone = normalizePhone(to, b.timezone);
      if (phone.replace(/\D/g, '').length < 8) { req.flash('error', 'Enter your mobile number, with country code, to get a test.'); return res.redirect(back); }
      if (channel === 'sms') await sendSms({ to: phone, body: msg.body });
      else await sendWhatsApp({ to: phone, body: msg.body, step: which, vars: msg.vars });
      req.flash('success', `Test ${channel === 'sms' ? 'text' : 'WhatsApp message'} sent to ${phone}.`);
    }
    if (config.messageMode === 'console') req.flash('info', 'Test mode is on, so the message was written to the server log instead of being delivered.');
  } catch (e) {
    req.flash('error', `The test could not be sent: ${e.message}`);
  }
  res.redirect(back);
});

export default r;
