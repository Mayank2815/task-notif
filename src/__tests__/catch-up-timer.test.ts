import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'catchup-timer-'));
process.env.DATA_DIR = dir;
// Keeps catchUp() observable without letting it reach Slack or Teamwork: it still walks
// every job and logs, but fires nothing.
process.env.SUPPRESS_CATCHUP = '1';

const { Scheduler, CATCHUP_POLL_MS, JOB_KINDS } = await import('../scheduler/index.js');

test.after(() => {
  delete process.env.SUPPRESS_CATCHUP;
  rmSync(dir, { recursive: true, force: true });
});

/** Counts how many times the catch-up walk happens, by watching what it logs. */
function watch() {
  const lines: string[] = [];
  const scheduler = new Scheduler({
    teamworkToken: '', slackToken: '',
    log: (m) => lines.push(m),
  });
  const sweeps = () => lines.filter((l) => l.includes('catch-up suppressed')).length / JOB_KINDS.length;
  return { scheduler, sweeps };
}

test('starting the scheduler checks the slot once, as it always did', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { scheduler, sweeps } = watch();
  try {
    scheduler.start();
    assert.equal(sweeps(), 1);
  } finally {
    scheduler.stop();
  }
});

test('the check repeats on its own — recovery no longer needs a restart', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { scheduler, sweeps } = watch();
  try {
    scheduler.start();
    t.mock.timers.tick(CATCHUP_POLL_MS);
    assert.equal(sweeps(), 2, 'a second check should have happened without any restart');
    t.mock.timers.tick(CATCHUP_POLL_MS * 3);
    assert.equal(sweeps(), 5, 'and it should keep going for the rest of the window');
  } finally {
    scheduler.stop();
  }
});

test('stopping the scheduler stops the checks', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { scheduler, sweeps } = watch();
  scheduler.start();
  t.mock.timers.tick(CATCHUP_POLL_MS);
  const before = sweeps();
  scheduler.stop();
  t.mock.timers.tick(CATCHUP_POLL_MS * 4);
  assert.equal(sweeps(), before, 'a stopped scheduler must not keep waking up');
});
