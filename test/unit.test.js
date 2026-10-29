import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAllowedTime, zonedToUtc, zonedParts, inQuietHours } from '../src/lib/time.js';
import { normalizePhone, parseCsv, guessColumns, parseLooseDate } from '../src/lib/util.js';
import { renderMessage, smsSegments, DEFAULT_TEMPLATES } from '../src/lib/templates.js';

const rules = { timezone: 'Europe/Malta', quiet_start: '20:00', quiet_end: '08:00', skip_sundays: true };

test('zonedToUtc round-trips across daylight saving', () => {
  const summer = zonedToUtc(2026, 7, 15, 10, 0, 'Europe/Malta');
  assert.equal(summer.toISOString(), '2026-07-15T08:00:00.000Z');
  const winter = zonedToUtc(2026, 12, 15, 10, 0, 'Europe/Malta');
  assert.equal(winter.toISOString(), '2026-12-15T09:00:00.000Z');
});

test('quiet hours push to 08:00 local', () => {
  // Thu 29 Oct 2026, 21:30 Malta (UTC+1) → Fri 30 Oct 08:00 Malta
  const t = nextAllowedTime(new Date('2026-10-29T20:30:00Z'), rules);
  assert.equal(t.toISOString(), '2026-10-30T07:00:00.000Z');
  // 06:00 → 08:00 same day
  assert.equal(nextAllowedTime(new Date('2026-10-30T05:00:00Z'), rules).toISOString(), '2026-10-30T07:00:00.000Z');
  // allowed time stays as is
  const ok = new Date('2026-10-29T10:00:00Z');
  assert.equal(nextAllowedTime(ok, rules).getTime(), ok.getTime());
});

test('Saturday night skips Sunday to Monday 08:00', () => {
  const t = nextAllowedTime(new Date('2026-10-31T21:00:00Z'), rules); // Sat 22:00 Malta
  const p = zonedParts(t, 'Europe/Malta');
  assert.equal(p.weekday, 1);
  assert.equal(p.hour, 8);
  assert.equal(p.minute, 0);
});

test('quiet hours can be switched off', () => {
  assert.equal(inQuietHours(23 * 60, '00:00', '00:00'), false);
  assert.equal(inQuietHours(23 * 60, '20:00', '08:00'), true);
  assert.equal(inQuietHours(12 * 60, '13:00', '14:00'), false);
});

test('phone numbers normalise to E.164', () => {
  assert.equal(normalizePhone('7912 4410', 'Europe/Malta'), '+35679124410');
  assert.equal(normalizePhone('+356 7912 4410', 'Europe/Malta'), '+35679124410');
  assert.equal(normalizePhone('0035679124410', 'Europe/Malta'), '+35679124410');
  assert.equal(normalizePhone('35679124410', 'Europe/Malta'), '+35679124410');
  assert.equal(normalizePhone('07700 900123', 'Europe/London'), '+447700900123');
  assert.equal(normalizePhone('whatsapp:+447700900123'), '+447700900123');
  assert.equal(normalizePhone(''), '');
});

test('CSV parsing handles quotes, semicolons and BOM', () => {
  const rows = parseCsv('﻿Name;Phone\n"Borg, Maria";79124410\r\n"Say ""hi""";1\n');
  assert.deepEqual(rows, [['Name', 'Phone'], ['Borg, Maria', '79124410'], ['Say "hi"', '1']]);
  const g = guessColumns(['Customer Name', 'Mobile Phone', 'Email Address', 'Invoice Number']);
  assert.equal(g.name, 0); assert.equal(g.phone, 1); assert.equal(g.email, 2); assert.equal(g.reference, 3);
  assert.equal(parseLooseDate('28/10/2026').getUTCDate(), 28);
});

test('templates fill tokens and protect the link and opt-out line', () => {
  const m = renderMessage('sms', { body: 'Hi {first_name}, thanks!' }, { customerName: 'Maria Borg', businessName: 'Harbourline', service: '', link: 'https://x.test/r/abc' });
  assert.equal(m.body, 'Hi Maria, thanks! https://x.test/r/abc Reply STOP to opt out');
  const e = renderMessage('email', DEFAULT_TEMPLATES.email.first, { customerName: 'Joseph Camilleri', businessName: 'Harbourline', service: 'bathroom refit', link: 'L' });
  assert.equal(e.subject, 'How did we do, Joseph?');
  assert.match(e.body, /for your bathroom refit/);
});

test('SMS segment counting', () => {
  assert.equal(smsSegments('a'.repeat(160)).segments, 1);
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('Thanks 🙂').single, 70);
});

test('reviewer names match customers', async () => {
  process.env.DATABASE_URL ||= 'postgres://postgres@localhost:5432/northstar_test';
  const { namesMatch } = await import('../src/lib/engine.js');
  assert.equal(namesMatch('Maria Borg', 'Maria Borg'), true);
  assert.equal(namesMatch('maria b.', 'Maria Borg'), true);
  assert.equal(namesMatch('Mária Borg', 'Maria Borg'), true);
  assert.equal(namesMatch('Maria', 'Maria Borg'), false);
  assert.equal(namesMatch('Anna Borg', 'Maria Borg'), false);
});
