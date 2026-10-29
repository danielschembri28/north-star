export const initials = (name = '') =>
  String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export const firstName = (name = '') => String(name).trim().split(/\s+/)[0] || 'there';

export const stars = (n) => {
  const r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
};

export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const CALLING_CODES = {
  'Europe/Malta': '356', 'Europe/London': '44', 'Europe/Dublin': '353', 'Europe/Rome': '39', 'Europe/Paris': '33',
  'Europe/Berlin': '49', 'Europe/Madrid': '34', 'Europe/Amsterdam': '31', 'Europe/Athens': '30', 'Europe/Lisbon': '351',
  'America/New_York': '1', 'America/Chicago': '1', 'America/Denver': '1', 'America/Los_Angeles': '1', 'America/Toronto': '1',
  'Australia/Sydney': '61', 'Australia/Melbourne': '61', 'Pacific/Auckland': '64', 'Asia/Dubai': '971', 'Asia/Singapore': '65'
};

const TRUNK_ZERO = new Set(['44', '353', '49', '33', '31', '61', '64', '971', '351']);

// Normalise a phone number to E.164 (+35679124410). Numbers without a country
// code get the business's country code, guessed from its time zone.
export function normalizePhone(raw, timezone = 'Europe/Malta') {
  if (!raw) return '';
  let s = String(raw).trim().replace(/^whatsapp:/i, '');
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return '';
  if (hadPlus) return '+' + s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  const cc = CALLING_CODES[timezone];
  if (cc) {
    if (s.startsWith(cc) && s.length > cc.length + 7) return '+' + s;
    if (s.startsWith('0') && TRUNK_ZERO.has(cc)) s = s.slice(1); // national trunk prefix, e.g. UK 07…
    return '+' + cc + s;
  }
  return '+' + s;
}

export function formatPhone(e164) {
  if (!e164) return '';
  const m = /^\+356(\d{4})(\d{4})$/.exec(e164);
  if (m) return `+356 ${m[1]} ${m[2]}`;
  return e164;
}

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

export const cleanUrl = (s) => {
  const v = String(s || '').trim();
  if (!v) return '';
  const withProto = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  try {
    const u = new URL(withProto);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
};

export const displayUrl = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM).
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}

export function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}

// Guess which CSV column holds which field from its header.
export function guessColumns(headers) {
  const find = (...words) => headers.findIndex((h) => words.some((w) => h.toLowerCase().replace(/[^a-z]/g, '').includes(w)));
  return {
    name: find('fullname', 'customername', 'contactname', 'name', 'client'),
    first: find('firstname', 'givenname', 'first'),
    last: find('lastname', 'surname', 'familyname', 'last'),
    phone: find('mobile', 'phone', 'cell', 'whatsapp', 'tel'),
    email: find('email', 'mail'),
    service: find('service', 'job', 'item', 'description', 'treatment'),
    reference: find('invoice', 'reference', 'ref', 'number'),
    date: find('date', 'completed', 'paid', 'visit')
  };
}

export function parseLooseDate(s) {
  if (!s) return null;
  const v = String(s).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v); // dd/mm/yyyy (European default)
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = new Date(Date.UTC(y, +m[2] - 1, +m[1], 12));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
