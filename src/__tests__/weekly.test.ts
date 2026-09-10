import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { digestWindow } from '../digest.js';
import { nextFireTime } from '../scheduler/index.js';

const IST = 'Asia/Kolkata';
const config = ConfigSchema.parse({ timezone: IST });
const at = (iso: string) => DateTime.fromISO(iso, { zone: IST });

/** Mirrors the span the weekly branch derives in runAndDeliver. */
const weekSpan = (now: DateTime) => now.setZone(IST).weekday;

test('the weekly job defaults to Friday at 19:00', () => {
  assert.equal(config.jobs.weekly.time, '19:00');
  assert.deepEqual(config.jobs.weekly.daysOfWeek, [5]);
  assert.equal(config.jobs.weekly.enabled, true);
});

test('it fires on Friday evening, not Monday morning', () => {
  const next = nextFireTime(config, config.jobs.weekly, at('2026-09-07T09:30')); // Monday
  assert.equal(next?.toFormat('cccc yyyy-MM-dd HH:mm'), 'Friday 2026-09-11 19:00');
});

test('once Friday evening has passed it rolls to the next Friday', () => {
  const next = nextFireTime(config, config.jobs.weekly, at('2026-09-11T19:30'));
  assert.equal(next?.toFormat('cccc yyyy-MM-dd'), 'Friday 2026-09-18');
});

test('a Friday run covers Monday through Friday', () => {
  const now = at('2026-09-11T19:00');
  const w = digestWindow(config, now, 0, weekSpan(now));
  assert.equal(weekSpan(now), 5);
  assert.equal(w.start.toFormat('cccc yyyy-MM-dd'), 'Monday 2026-09-07');
  assert.equal(w.end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-11 19:00');
});

test('the label names both ends of the week', () => {
  const now = at('2026-09-11T19:00');
  assert.equal(digestWindow(config, now, 0, weekSpan(now)).label, 'Monday, 7 September – Friday, 11 September');
});

test('moved to a Thursday it reports Monday to Thursday, not last week too', () => {
  const now = at('2026-09-10T19:00'); // Thursday
  const w = digestWindow(config, now, 0, weekSpan(now));
  assert.equal(weekSpan(now), 4);
  assert.equal(w.start.toFormat('cccc yyyy-MM-dd'), 'Monday 2026-09-07');
});

test('it never reaches back into the previous week', () => {
  for (const day of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    const now = at(`${day}T19:00`);
    const w = digestWindow(config, now, 0, weekSpan(now));
    assert.equal(
      w.start.toFormat('cccc'), 'Monday',
      `a run on ${day} should start on this week's Monday`,
    );
  }
});

test('the reminder and digest jobs are untouched', () => {
  assert.equal(config.jobs.reminder.time, '09:00');
  assert.equal(config.jobs.digest.time, '21:00');
  assert.deepEqual(config.jobs.digest.daysOfWeek, [1, 2, 3, 4, 5]);
});
