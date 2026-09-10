import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { digestWindow } from '../digest.js';
import { windowFor } from '../report.js';

const IST = 'Asia/Kolkata';
const config = ConfigSchema.parse({ timezone: IST });
const now = DateTime.fromISO('2026-09-11T14:30', { zone: IST }); // a Friday afternoon

test('a whole past month becomes the right offset and span', () => {
  const w = windowFor('2026-08-01', '2026-08-31', IST, now);
  assert.equal(w.spanDays, 31);
  assert.equal(w.dayOffset, 11); // 31 Aug is eleven days before 11 Sep
});

test('the window that offset and span produce really is that month', () => {
  const { dayOffset, spanDays } = windowFor('2026-08-01', '2026-08-31', IST, now);
  const w = digestWindow(config, now, dayOffset, spanDays);
  assert.equal(w.start.toFormat('yyyy-MM-dd'), '2026-08-01');
  assert.equal(w.end.toFormat('yyyy-MM-dd'), '2026-08-31');
});

test('a quarter works the same way', () => {
  const { dayOffset, spanDays } = windowFor('2026-04-01', '2026-06-30', IST, now);
  const w = digestWindow(config, now, dayOffset, spanDays);
  assert.equal(spanDays, 91);
  assert.equal(w.start.toFormat('yyyy-MM-dd'), '2026-04-01');
  assert.equal(w.end.toFormat('yyyy-MM-dd'), '2026-06-30');
});

test('a range ending today keeps the whole range, not just today', () => {
  const { dayOffset, spanDays } = windowFor('2026-09-01', '2026-09-11', IST, now);
  assert.equal(dayOffset, 0);
  const w = digestWindow(config, now, dayOffset, spanDays);
  assert.equal(w.start.toFormat('yyyy-MM-dd'), '2026-09-01');
  assert.equal(w.end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-11 14:30');
});

test('a single past day is a span of one', () => {
  const w = windowFor('2026-09-10', '2026-09-10', IST, now);
  assert.equal(w.spanDays, 1);
  assert.equal(w.dayOffset, 1);
});

test('the evening digest is untouched — today so far is still today so far', () => {
  const w = digestWindow(config, now, 0, 1);
  assert.equal(w.start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-11 00:00');
  assert.equal(w.end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-11 14:30');
  assert.equal(w.label, 'Friday, 11 September');
});

test('a backwards range is refused rather than returning nothing', () => {
  assert.throws(() => windowFor('2026-08-31', '2026-08-01', IST, now), /cannot be before/);
});

test('a future end date is refused', () => {
  assert.throws(() => windowFor('2026-09-01', '2026-12-01', IST, now), /cannot be in the future/);
});

test('nonsense dates are refused with something a person can read', () => {
  assert.throws(() => windowFor('last august', '2026-08-31', IST, now), /2026-08-01/);
});

test('the range is read in the configured timezone, not the host clock', () => {
  // 19:30 UTC on 10 Sep is already 11 Sep in Kolkata.
  const utcEvening = DateTime.fromISO('2026-09-10T19:30', { zone: 'utc' });
  assert.equal(windowFor('2026-09-11', '2026-09-11', IST, utcEvening).dayOffset, 0);
});
