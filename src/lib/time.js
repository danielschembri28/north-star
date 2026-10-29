// Time-zone helpers built on Intl, so quiet hours and "today" follow each
// business's own clock (Europe/Malta by default), including daylight saving.

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    }));
  }
  return fmtCache.get(tz);
}

export function zonedParts(date, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour, minute: +out.minute, second: +out.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday)
  };
}

// Offset (ms) of tz at the given instant: local wall time minus UTC.
function offsetAt(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Convert a local wall-clock time in tz to a UTC Date.
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offsetAt(new Date(guess), tz);
  // Second pass settles DST transitions.
  ts = guess - offsetAt(new Date(ts), tz);
  return new Date(ts);
}

export const hm = (s) => {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function inQuietHours(minutesOfDay, quietStart, quietEnd) {
  const s = hm(quietStart);
  const e = hm(quietEnd);
  if (s === e) return false;
  return s > e ? minutesOfDay >= s || minutesOfDay < e : minutesOfDay >= s && minutesOfDay < e;
}

function addLocalDays(p, days) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

// Earliest moment >= `date` when a message may be sent.
export function nextAllowedTime(date, { timezone, quiet_start, quiet_end, skip_sundays }) {
  const tz = timezone || 'Europe/Malta';
  let t = new Date(date);
  for (let i = 0; i < 10; i++) {
    const p = zonedParts(t, tz);
    const mins = p.hour * 60 + p.minute;
    const quiet = inQuietHours(mins, quiet_start, quiet_end);
    const sunday = skip_sundays && p.weekday === 0;
    if (!quiet && !sunday) return t;
    const end = hm(quiet_end);
    const endH = Math.floor(end / 60);
    const endM = end % 60;
    let target;
    if (sunday) {
      const next = addLocalDays(p, 1);
      target = zonedToUtc(next.year, next.month, next.day, quiet_start === quiet_end ? 0 : endH, quiet_start === quiet_end ? 0 : endM, tz);
    } else if (mins < end) {
      target = zonedToUtc(p.year, p.month, p.day, endH, endM, tz);
    } else {
      const next = addLocalDays(p, 1);
      target = zonedToUtc(next.year, next.month, next.day, endH, endM, tz);
    }
    if (target <= t) target = new Date(t.getTime() + 60_000);
    t = target;
  }
  return t;
}

export function startOfLocalDay(date, tz) {
  const p = zonedParts(date, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function startOfLocalMonth(date, tz) {
  const p = zonedParts(date, tz);
  return zonedToUtc(p.year, p.month, 1, 0, 0, tz);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

export function fmtTime(date, tz) {
  if (!date) return '';
  const p = zonedParts(new Date(date), tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function fmtDate(date, tz, withYear = false) {
  if (!date) return '';
  const p = zonedParts(new Date(date), tz);
  return `${p.day} ${MONTHS[p.month - 1]}${withYear ? ' ' + p.year : ''}`;
}

export function fmtDateTime(date, tz) {
  if (!date) return '';
  const d = new Date(date);
  return `${DAYS[zonedParts(d, tz).weekday]} ${fmtDate(d, tz)} at ${fmtTime(d, tz)}`;
}

export function dayLabel(date, tz, now = new Date()) {
  const d = new Date(date);
  const p = zonedParts(d, tz);
  const key = (x) => `${x.year}-${x.month}-${x.day}`;
  const today = zonedParts(now, tz);
  const y = zonedParts(new Date(now.getTime() - 86400000), tz);
  const base = `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
  if (key(p) === key(today)) return `Today, ${base}`;
  if (key(p) === key(y)) return `Yesterday, ${base}`;
  return base + (p.year !== today.year ? ' ' + p.year : '');
}

export function timeAgo(date, now = new Date()) {
  if (!date) return '';
  const s = Math.max(0, (now - new Date(date)) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) { const h = Math.floor(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.floor(s / 86400);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return `${m} month${m === 1 ? '' : 's'} ago`;
}

export function greeting(tz, now = new Date()) {
  const h = zonedParts(now, tz).hour;
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function delayLabel(minutes) {
  const m = Number(minutes) || 0;
  if (m === 0) return 'Straight away';
  if (m % 1440 === 0) { const d = m / 1440; return `${d} day${d === 1 ? '' : 's'}`; }
  if (m % 60 === 0) { const h = m / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${m} minutes`;
}

export const TIMEZONES = [
  'Europe/Malta', 'Europe/London', 'Europe/Dublin', 'Europe/Rome', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Lisbon', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Toronto', 'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'Asia/Dubai', 'Asia/Singapore', 'UTC'
];
