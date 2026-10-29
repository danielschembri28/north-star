// Optional subscription billing with Stripe Checkout and the customer portal.
// Leave STRIPE_SECRET_KEY empty to run without billing.
import { one, query } from '../db.js';
import { config } from '../config.js';
import { hmac, safeEqual } from './crypto.js';

async function stripe(path, params = {}, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe error ${res.status}`);
  return data;
}

export async function checkoutUrl(business, user) {
  let customerId = business.stripe_customer_id;
  if (!customerId) {
    const c = await stripe('customers', { email: user.email, name: business.name, 'metadata[business_id]': business.id });
    customerId = c.id;
    await query('UPDATE businesses SET stripe_customer_id = $2 WHERE id = $1', [business.id, customerId]);
  }
  const s = await stripe('checkout/sessions', {
    mode: 'subscription', customer: customerId,
    'line_items[0][price]': config.stripe.priceId, 'line_items[0][quantity]': '1',
    client_reference_id: business.id,
    success_url: `${config.baseUrl}/settings?billing=success#billing`,
    cancel_url: `${config.baseUrl}/settings#billing`,
    allow_promotion_codes: 'true'
  });
  return s.url;
}

export async function portalUrl(business) {
  const s = await stripe('billing_portal/sessions', { customer: business.stripe_customer_id, return_url: `${config.baseUrl}/settings#billing` });
  return s.url;
}

async function applySubscription(sub) {
  const business = await one('SELECT * FROM businesses WHERE stripe_customer_id = $1', [sub.customer]);
  if (!business) return;
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
  await query(
    'UPDATE businesses SET plan = $2, plan_status = $3, stripe_subscription_id = $4, plan_renews_at = $5, monthly_message_limit = $6 WHERE id = $1',
    [business.id, active ? config.stripe.planName.toLowerCase() : 'trial', sub.status, sub.id, end ? new Date(end * 1000) : null,
      active ? config.stripe.planMonthlyMessages : config.defaultMonthlyMessages]
  );
}

// https://docs.stripe.com/webhooks#verify-manually
export async function handleStripeWebhook(req, res) {
  const body = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const header = req.get('stripe-signature') || '';
  const pairs = header.split(',').map((p) => p.split('='));
  const t = pairs.find(([k]) => k === 't')?.[1];
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  const expected = config.stripe.webhookSecret ? hmac('sha256', config.stripe.webhookSecret, `${t}.${body}`) : '';
  if (!expected || !t || !sigs.some((s) => safeEqual(s, expected)) || Math.abs(Date.now() / 1000 - Number(t)) > 300) {
    return res.status(400).send('Bad signature');
  }
  const event = JSON.parse(body);
  try {
    if (event.type === 'checkout.session.completed' && event.data.object.subscription) {
      const sub = await stripe(`subscriptions/${event.data.object.subscription}`, {}, 'GET');
      await applySubscription(sub);
    } else if (event.type.startsWith('customer.subscription.')) {
      await applySubscription(event.data.object);
    }
  } catch (e) {
    console.error('stripe webhook', e.message);
    return res.status(500).send('Error');
  }
  res.json({ received: true });
}
