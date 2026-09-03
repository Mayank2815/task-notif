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

// The real configuration: 09:00 reminder, 5-hour grace.
const live = ConfigSchema.parse({ timezone: IST, jobs: { reminder: { time: '09:00' } }, catchUpGraceMinutes: 300 });
const liveJob = live.jobs.reminder;

test('a machine switched on at 11:00 still gets the missed 09:00 reminder', () => {
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:00'), null), true);
});

test('a failed run does not count as delivered — only successes are passed in', () => {
  // The scheduler filters on ok, so a failure never reaches this argument and the
  // slot stays owed. A genuine success at 09:00 does suppress it.
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:00'), null), true);
  const deliveredAt = at('2026-09-03T09:00').toISO()!;
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:00'), deliveredAt), false);
});

test('switched on at 13:59 — just inside the 5-hour grace', () => {
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T13:59'), null), true);
});

test('switched on at 14:30 — past the grace, skipped rather than sending a stale list', () => {
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T14:30'), null), false);
});

test('a longer grace covers a machine switched on much later', () => {
  const patient = ConfigSchema.parse({ ...live, catchUpGraceMinutes: 720 });
  assert.equal(shouldCatchUp(patient, patient.jobs.reminder, at('2026-09-03T20:00'), null), true);
});

test('a manual send after the slot satisfies it — no duplicate on restart', () => {
  // Sent by hand at 09:45 after the 09:00 slot was missed, then the app restarts at 11:29.
  const sentByHand = at('2026-09-03T09:45').toISO()!;
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:29'), sentByHand), false);
});

test('a manual send BEFORE the slot does not satisfy it', () => {
  const sentEarly = at('2026-09-03T08:00').toISO()!;
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:00'), sentEarly), true);
});

test('yesterday\'s successful send does not satisfy today', () => {
  const yesterday = at('2026-09-02T09:00').toISO()!;
  assert.equal(shouldCatchUp(live, liveJob, at('2026-09-03T11:00'), yesterday), true);
});
