import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { digestWindow, extractPrLinks } from '../digest.js';

test('extracts a GitHub pull request link', () => {
  assert.deepEqual(
    extractPrLinks('Raised https://github.com/acme/web/pull/1423 for review'),
    ['https://github.com/acme/web/pull/1423'],
  );
});

test('extracts the AWS CodeSuite link style used in this workspace', () => {
  // real comment text
  const text = 'The backmerge PRs are raised for rc_core_3.97.1 in dev . Client PR : https://us-east-2.console.aws.amazon.com/codesuite/codecommit/repositories/x/pull-requests/55';
  const found = extractPrLinks(text);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /codesuite/);
});

test('extracts several distinct links and de-duplicates', () => {
  const text = 'https://github.com/a/b/pull/1 and https://github.com/a/b/pull/2 and https://github.com/a/b/pull/1';
  assert.equal(extractPrLinks(text).length, 2);
});

test('finds nothing in a comment with no PR', () => {
  assert.deepEqual(extractPrLinks('I have traced the issue but it is not reproducible'), []);
});

test('a bare repo link is not treated as a pull request', () => {
  assert.deepEqual(extractPrLinks('see https://github.com/acme/web for context'), []);
});

test('the digest window covers today in the configured timezone', () => {
  const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
  // 20:30 UTC is already the next day in IST — the window must follow IST, not UTC
  const now = DateTime.fromISO('2026-09-02T20:30:00Z');
  const { start, label } = digestWindow(config, now);
  assert.equal(start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 00:00');
  assert.equal(label, 'Thursday, 3 September');
});

test('the window starts at local midnight, not 24 hours back', () => {
  const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
  const now = DateTime.fromISO('2026-09-02T21:00', { zone: 'Asia/Kolkata' });
  assert.equal(digestWindow(config, now).start.toISO()?.slice(0, 16), '2026-09-02T00:00');
});

test('a day offset of 1 covers the whole of yesterday, not today so far', () => {
  const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
  const now = DateTime.fromISO('2026-09-04T09:15', { zone: 'Asia/Kolkata' });
  const w = digestWindow(config, now, 1);
  assert.equal(w.start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 00:00');
  assert.equal(w.end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 23:59');
  assert.equal(w.label, 'Thursday, 3 September');
});

test('yesterday is measured in the configured timezone, not UTC', () => {
  const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
  // 20:00 UTC is already the next morning in IST, so "yesterday" moves with it
  const now = DateTime.fromISO('2026-09-03T20:00:00Z');
  assert.equal(digestWindow(config, now, 1).start.toFormat('yyyy-MM-dd'), '2026-09-03');
});

test('offset 0 still means today up to now', () => {
  const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
  const now = DateTime.fromISO('2026-09-04T09:15', { zone: 'Asia/Kolkata' });
  const w = digestWindow(config, now, 0);
  assert.equal(w.start.toFormat('yyyy-MM-dd'), '2026-09-04');
  assert.equal(w.end.toFormat('HH:mm'), '09:15');
});
