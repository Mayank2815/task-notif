import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The retry ladder that replaced "log the error and wait until tomorrow".
 * Mirrors RETRY_DELAYS_MS in the scheduler.
 */
const RETRY_DELAYS_MS = [60_000, 180_000, 600_000, 1_800_000];

function planAttempts(failuresBeforeSuccess: number): { attempts: number; gaveUp: boolean; totalMinutes: number } {
  let attempts = 1;
  let total = 0;
  while (attempts <= failuresBeforeSuccess) {
    const delay = RETRY_DELAYS_MS[attempts - 1];
    if (delay === undefined) return { attempts, gaveUp: true, totalMinutes: total / 60_000 };
    total += delay;
    attempts++;
  }
  return { attempts, gaveUp: false, totalMinutes: total / 60_000 };
}

test('a run that works first time never retries', () => {
  const r = planAttempts(0);
  assert.equal(r.attempts, 1);
  assert.equal(r.gaveUp, false);
});

test('the real failure — network down at 09:00, back a minute later', () => {
  const r = planAttempts(1);
  assert.equal(r.attempts, 2);
  assert.equal(r.totalMinutes, 1);
  assert.equal(r.gaveUp, false);
});

test('a laptop slow to reconnect still gets its reminder', () => {
  const r = planAttempts(3);
  assert.equal(r.attempts, 4);
  assert.equal(r.totalMinutes, 1 + 3 + 10);
  assert.equal(r.gaveUp, false);
});

test('the ladder covers roughly the first hour', () => {
  assert.equal(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 60_000, 44);
});

test('a genuine outage gives up rather than retrying forever', () => {
  const r = planAttempts(RETRY_DELAYS_MS.length + 1);
  assert.equal(r.gaveUp, true);
  assert.equal(r.attempts, RETRY_DELAYS_MS.length + 1);
});

test('delays increase, so a long outage is not hammered', () => {
  for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
    assert.ok(RETRY_DELAYS_MS[i]! > RETRY_DELAYS_MS[i - 1]!);
  }
});
