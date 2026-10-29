import { Router } from 'express';
import { requireRole } from '../lib/auth.js';
import { providers } from '../config.js';
import { checkoutUrl, portalUrl } from '../lib/stripe.js';

const r = Router();

r.post('/billing/checkout', requireRole('owner'), async (req, res) => {
  if (!providers.stripeReady()) { req.flash('error', 'Billing is not set up on this server.'); return res.redirect('/settings#billing'); }
  try {
    res.redirect(303, await checkoutUrl(req.business, req.user));
  } catch (e) {
    req.flash('error', `Could not open checkout: ${e.message}`);
    res.redirect('/settings#billing');
  }
});

r.post('/billing/portal', requireRole('owner'), async (req, res) => {
  if (!providers.stripeReady() || !req.business.stripe_customer_id) return res.redirect('/settings#billing');
  try {
    res.redirect(303, await portalUrl(req.business));
  } catch (e) {
    req.flash('error', `Could not open billing: ${e.message}`);
    res.redirect('/settings#billing');
  }
});

export default r;
