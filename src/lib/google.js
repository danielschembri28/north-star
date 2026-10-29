// Google Business Profile: pulls your Google reviews in, links them to the
// customers who were asked, and lets you reply from NorthStar.
// Needs Business Profile API access approved for your Google Cloud project:
// https://developers.google.com/my-business/content/prereqs
import { many, one, query } from '../db.js';
import { config, providers } from '../config.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { recordReview } from './engine.js';
import { logEvent } from './events.js';

const redirectUri = () => `${config.baseUrl}/integrations/google/callback`;
const RATING = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export async function googleAuthUrl(business, user) {
  const state = randomToken(24);
  await query('INSERT INTO oauth_states (state, business_id, user_id, provider) VALUES ($1,$2,$3,$4)', [state, business.id, user.id, 'google']);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: 'https://www.googleapis.com/auth/business.manage', access_type: 'offline', prompt: 'consent', state
  }).toString();
  return u.toString();
}

async function token(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token error ${res.status}`);
  return data;
}

async function accessToken(integ) {
  if (integ.expires_at && new Date(integ.expires_at) > new Date()) return decrypt(integ.access_token);
  try {
    const t = await token({ grant_type: 'refresh_token', refresh_token: decrypt(integ.refresh_token) });
    await query('UPDATE integrations SET access_token = $2, expires_at = $3 WHERE id = $1', [integ.id, encrypt(t.access_token), new Date(Date.now() + (t.expires_in - 60) * 1000)]);
    return t.access_token;
  } catch (e) {
    await query("UPDATE integrations SET status = 'error', error_message = $2, error_at = now() WHERE id = $1", [integ.id, 'Google sign-in expired, so new reviews are not being pulled in.']);
    throw e;
  }
}

async function gGet(integ, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(integ)}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Google API ${res.status}`);
  return data;
}

export async function completeGoogleAuth(code, stateRow) {
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const integ = await one(
    `INSERT INTO integrations (business_id, provider, status, access_token, refresh_token, expires_at)
     VALUES ($1,'google','connected',$2,$3,$4)
     ON CONFLICT (business_id, provider) DO UPDATE SET status = 'connected', access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, integrations.refresh_token), expires_at = EXCLUDED.expires_at, error_message = NULL, error_at = NULL
     RETURNING *`,
    [stateRow.business_id, encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, new Date(Date.now() + (t.expires_in - 60) * 1000)]
  );
  // Find the first location on the account.
  const accounts = await gGet(integ, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const account = accounts.accounts?.[0];
  if (!account) throw new Error('No Google Business Profile account found for this Google user.');
  const locs = await gGet(integ, `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,metadata&pageSize=100`);
  const loc = locs.locations?.[0];
  if (!loc) throw new Error('No business location found on this Google account.');
  const meta = { account: account.name, location: loc.name, title: loc.title, reviewUrl: loc.metadata?.newReviewUri || '' };
  await query('UPDATE integrations SET account_name = $2, meta = $3 WHERE id = $1', [integ.id, loc.title, JSON.stringify(meta)]);
  if (meta.reviewUrl) await query("UPDATE businesses SET google_review_url = CASE WHEN google_review_url = '' THEN $2 ELSE google_review_url END WHERE id = $1", [stateRow.business_id, meta.reviewUrl]);
  await logEvent(null, { business_id: stateRow.business_id, type: 'integration', text: `Connected Google Business Profile (${loc.title})` });
  syncGoogleReviews({ ...integ, meta }).catch((e) => console.error('google sync', e.message));
}

export async function syncGoogleReviews(integ) {
  const business = await one('SELECT * FROM businesses WHERE id = $1', [integ.business_id]);
  const meta = typeof integ.meta === 'string' ? JSON.parse(integ.meta) : integ.meta;
  if (!meta?.location) return 0;
  const locId = meta.location.split('/').pop();
  let pageToken = '';
  let added = 0;
  for (let i = 0; i < 10; i++) {
    const url = `https://mybusiness.googleapis.com/v4/${meta.account}/locations/${locId}/reviews?pageSize=50&orderBy=updateTime%20desc${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await gGet(integ, url);
    for (const rv of data.reviews || []) {
      const { created } = await recordReview(business, {
        platform: 'google',
        rating: RATING[rv.starRating] || 5,
        text: rv.comment || '',
        reviewer_name: rv.reviewer?.displayName || '',
        reviewed_at: new Date(rv.createTime),
        external_id: rv.reviewId || rv.name,
        reply_text: rv.reviewReply?.comment || null,
        replied_at: rv.reviewReply?.updateTime ? new Date(rv.reviewReply.updateTime) : null
      });
      if (created) added++;
    }
    if (!data.nextPageToken || added === 0) break;
    pageToken = data.nextPageToken;
  }
  await query("UPDATE integrations SET last_sync_at = now(), status = 'connected' WHERE id = $1", [integ.id]);
  return added;
}

export async function replyOnGoogle(businessId, review, comment) {
  const integ = await one("SELECT * FROM integrations WHERE business_id = $1 AND provider = 'google' AND status = 'connected'", [businessId]);
  if (!integ || !review.external_id) return false;
  const meta = integ.meta;
  const locId = meta.location.split('/').pop();
  const res = await fetch(`https://mybusiness.googleapis.com/v4/${meta.account}/locations/${locId}/reviews/${review.external_id}/reply`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await accessToken(integ)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment })
  });
  if (!res.ok) throw new Error(`Google refused the reply (${res.status}).`);
  return true;
}

export async function pollAllGoogle() {
  if (!providers.googleReady()) return;
  const list = await many("SELECT * FROM integrations WHERE provider = 'google' AND status = 'connected'");
  for (const integ of list) await syncGoogleReviews(integ).catch((e) => console.error('google poll', e.message));
}
