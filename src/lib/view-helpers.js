import { icon, starMark } from './icons.js';
import { initials, stars, formatPhone, displayUrl, firstName } from './util.js';
import { fmtDate, fmtTime, fmtDateTime, timeAgo, greeting, delayLabel } from './time.js';
import { CHANNEL_LABEL } from './events.js';

const STATUS_BADGE = {
  'Not sent': 'b-gray', Scheduled: 'b-gray', Waiting: 'b-amber', Sent: 'b-blue', Delivered: 'b-blue', Clicked: 'b-amber',
  Reviewed: 'b-green', 'Opted out': 'b-red', Failed: 'b-red', Skipped: 'b-gray', Cancelled: 'b-gray'
};
const DOT = { Reviewed: '#127A4B', Clicked: '#C98A00', Delivered: '#2754C5', Sent: '#2754C5', Scheduled: '#8A93A6', Waiting: '#8A93A6', Skipped: '#8A93A6', Failed: '#B42318', 'Opted out': '#B42318', Imported: '#8A93A6', Connected: '#127A4B', Problem: '#B42318' };

export function helpers(business) {
  const tz = business?.timezone || 'Europe/Malta';
  return {
    icon, starMark, initials, stars, formatPhone, displayUrl, firstName, delayLabel,
    date: (d, y) => fmtDate(d, tz, y),
    time: (d) => fmtTime(d, tz),
    dateTime: (d) => fmtDateTime(d, tz),
    ago: (d) => timeAgo(d),
    greeting: () => greeting(tz),
    channel: (c) => CHANNEL_LABEL[c] || '',
    badge: (status) => STATUS_BADGE[status] || 'b-gray',
    dot: (status) => DOT[status] || '#8A93A6',
    platform: (p) => ({ google: 'Google', facebook: 'Facebook', other: 'Other' }[p] || p),
    qs: (base, params) => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== 'All') u.set(k, v);
      const s = u.toString();
      return s ? `${base}?${s}` : base;
    },
    plural: (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`
  };
}
