import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { nextFireTime, shouldCatchUp } from '../scheduler/index.js';

const IST = 'Asia/Kolkata';
const base = ConfigSchema.parse({ timezone: IST, jobs: { reminder: { time: '10:00', daysOfWeek: [1, 2, 3, 4, 5] } } });
const job = base.jobs.reminder;
const at = (iso: string) => DateTime.fromISO(iso, { zone: IST });

test('fires later the same weekday when the slot has not passed', () => {
  const next = nextFireTime(base, job, at('2026-09-02T08:00'));
  assert.equal(next?.toFormat('yyyy-MM-dd HH:mm'), '2026-09-02 10:00');
});

test('rolls to the next day once the slot has passed', () => {
  const next = nextFireTime(base, job, at('2026-09-02T10:30'));
  assert.equal(next?.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 10:00');
});

test('skips the weekend', () => {
  const next = nextFireTime(base, job, at('2026-09-04T11:00')); // Friday after the slot
  assert.equal(next?.toFormat('cccc yyyy-MM-dd'), 'Monday 2026-09-07');
});

test('exactly at the slot schedules the following day, never a double fire', () => {
  const next = nextFireTime(base, job, at('2026-09-02T10:00'));
  assert.equal(next?.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 10:00');
});

test('honours a non-default day set', () => {
  const weekendJob = { ...job, daysOfWeek: [6, 7] };
  const next = nextFireTime(base, weekendJob, at('2026-09-02T08:00'));
  assert.equal(next?.toFormat('cccc'), 'Saturday');
});

test('returns null when globally disabled', () => {
  assert.equal(nextFireTime({ ...base, enabled: false }, job, at('2026-09-02T08:00')), null);
});

test('returns null when just that job is disabled', () => {
  assert.equal(nextFireTime(base, { ...job, enabled: false }, at('2026-09-02T08:00')), null);
});

test('the digest job schedules independently of the reminder', () => {
  const cfg = ConfigSchema.parse({
    timezone: IST,
    jobs: { reminder: { time: '10:00' }, digest: { time: '21:00' } },
  });
  assert.equal(nextFireTime(cfg, cfg.jobs.reminder, at('2026-09-02T08:00'))?.toFormat('HH:mm'), '10:00');
  assert.equal(nextFireTime(cfg, cfg.jobs.digest, at('2026-09-02T08:00'))?.toFormat('HH:mm'), '21:00');
  // After the morning slot, the digest is what comes next today.
  assert.equal(nextFireTime(cfg, cfg.jobs.digest, at('2026-09-02T14:00'))?.toFormat('yyyy-MM-dd HH:mm'), '2026-09-02 21:00');
});

test('the configured timezone drives the slot, not the host clock', () => {
  const nz = ConfigSchema.parse({ timezone: 'Pacific/Auckland', jobs: { reminder: { time: '10:00' } } });
  const next = nextFireTime(nz, nz.jobs.reminder, DateTime.fromISO('2026-09-02T00:00', { zone: 'UTC' }));
  assert.equal(next?.setZone('Pacific/Auckland').toFormat('HH:mm'), '10:00');
});

test('catch-up fires when a restart lands just after a missed slot', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T10:20'), null), true);
});

test('no catch-up before the slot', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T09:59'), null), false);
});

test('a laptop opened hours later still gets the missed reminder', () => {
  // default grace is 5 hours: 10:00 slot, opened at 14:00
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T14:00'), null), true);
});

test('no catch-up once past the grace window', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T16:00'), null), false);
});

test('the grace window is configurable', () => {
  const strict = ConfigSchema.parse({ ...base, catchUpGraceMinutes: 30 });
  assert.equal(shouldCatchUp(strict, job, at('2026-09-02T10:20'), null), true);
  assert.equal(shouldCatchUp(strict, job, at('2026-09-02T11:00'), null), false);
});

test('no catch-up when the slot was already delivered', () => {
  const sent = at('2026-09-02T10:00').toISO()!;
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T10:30'), sent), false);
});

test('catch-up still fires when the last run was yesterday', () => {
  const sent = at('2026-09-01T10:00').toISO()!;
  assert.equal(shouldCatchUp(base, job, at('2026-09-02T10:30'), sent), true);
});

test('no catch-up on a disabled weekday', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-05T10:30'), null), false); // Saturday
});
