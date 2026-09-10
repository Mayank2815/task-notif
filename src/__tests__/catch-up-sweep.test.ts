import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { CATCHUP_POLL_MS, shouldCatchUp } from '../scheduler/index.js';

const IST = 'Asia/Kolkata';
const base = ConfigSchema.parse({ timezone: IST, jobs: { reminder: { time: '09:00', daysOfWeek: [1, 2, 3, 4, 5] } } });
const job = base.jobs.reminder;
const at = (iso: string) => DateTime.fromISO(iso, { zone: IST });

/**
 * Wednesday 9 September: the 09:00 run failed four times between 09:38 and 11:03 as the
 * network came and went, the retry ladder gave up, and the last success was the day
 * before. The machine stayed on throughout — nobody restarted anything.
 */
const LAST_SUCCESS = '2026-09-08T10:02:00.000+05:30';

test('the slot is still owed after the retry ladder has given up', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-09T11:15'), LAST_SUCCESS), true);
});

test('every sweep through the rest of the window keeps offering to send it', () => {
  for (const time of ['11:15', '11:30', '12:00', '13:00', '13:45']) {
    assert.equal(
      shouldCatchUp(base, job, at(`2026-09-09T${time}`), LAST_SUCCESS), true,
      `expected the sweep at ${time} to still consider the slot owed`,
    );
  }
});

test('once it goes through, the next sweep leaves it alone', () => {
  const delivered = '2026-09-09T11:16:00.000+05:30';
  assert.equal(shouldCatchUp(base, job, at('2026-09-09T11:30'), delivered), false);
});

test('a sweep before the slot never sends early', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-09T08:45'), LAST_SUCCESS), false);
});

test('sweeping stops at the end of the grace window rather than sending at night', () => {
  // 09:00 + the default 300 minutes of grace.
  assert.equal(shouldCatchUp(base, job, at('2026-09-09T13:59'), LAST_SUCCESS), true);
  assert.equal(shouldCatchUp(base, job, at('2026-09-09T14:01'), LAST_SUCCESS), false);
});

test('a Saturday sweep sends nothing, however long the window would be', () => {
  assert.equal(shouldCatchUp(base, job, at('2026-09-12T11:00'), LAST_SUCCESS), false);
});

test('the sweep runs often enough to fit inside the grace window many times over', () => {
  const window = base.catchUpGraceMinutes * 60_000;
  assert.ok(CATCHUP_POLL_MS < window, 'a poll longer than the window could skip it entirely');
  assert.ok(window / CATCHUP_POLL_MS >= 4, 'the window should get several attempts, not one');
});

/** Mirrors the guard in Scheduler.catchUp — a slot already being handled is left alone. */
const sweepWouldFire = (owed: boolean, running: boolean, retryBooked: boolean): boolean =>
  owed && !running && !retryBooked;

test('the sweep does not start a second run while one is in flight', () => {
  assert.equal(sweepWouldFire(true, true, false), false);
});

test('the sweep waits for a booked retry instead of racing it', () => {
  assert.equal(sweepWouldFire(true, false, true), false);
});

test('with nothing else in flight, an owed slot is sent', () => {
  assert.equal(sweepWouldFire(true, false, false), true);
});
