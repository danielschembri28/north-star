import { query } from '../db.js';
import { pollAllXero } from './xero.js';
import { pollAllGoogle } from './google.js';

const every = (ms, fn) => {
  const run = () => fn().catch((e) => console.error('background job failed', e.message));
  setTimeout(run, 15000).unref?.();
  setInterval(run, ms).unref?.();
};

export async function cleanup() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query("DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'");
  await query("DELETE FROM imports WHERE created_at < now() - interval '1 day'");
}

export function startSyncLoops() {
  every(10 * 60 * 1000, pollAllXero);
  every(30 * 60 * 1000, pollAllGoogle);
  every(6 * 60 * 60 * 1000, cleanup);
}
