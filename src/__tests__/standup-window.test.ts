import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { digestWindow, standupWindow } from '../digest.js';
import { mergeChannelActivity } from '../deliver.js';

const IST = 'Asia/Kolkata';
const weekdays = ConfigSchema.parse({ timezone: IST });

/** 09:00 IST on the given local date — the moment the reminder fires. */
const morningOf = (date: string): DateTime =>
  DateTime.fromISO(`${date}T09:00:00`, { zone: IST });

// 4 Sept 2026 is a Friday, so 7 Sept is the Monday that must carry the weekend.
const MONDAY = '2026-09-07';

test('Monday reaches back over the weekend to Friday', () => {
  const { start, end, days, label } = standupWindow(weekdays, morningOf(MONDAY));
  assert.equal(days, 3);
  assert.equal(start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-04 00:00');
  assert.equal(end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-06 23:59');
  assert.equal(label, 'Friday, 4 September – Sunday, 6 September');
});

test('a Friday comment falls inside Monday\'s window', () => {
  const { start, end } = standupWindow(weekdays, morningOf(MONDAY));
  const fridayAfternoon = DateTime.fromISO('2026-09-04T15:30:00', { zone: IST });
  assert.ok(fridayAfternoon >= start && fridayAfternoon <= end);
});

test('Thursday, the day before the window, is excluded', () => {
  const { start } = standupWindow(weekdays, morningOf(MONDAY));
  const thursdayEvening = DateTime.fromISO('2026-09-03T23:59:00', { zone: IST });
  assert.ok(thursdayEvening < start);
});

test('Monday morning itself is not swept into its own window', () => {
  const { end } = standupWindow(weekdays, morningOf(MONDAY));
  assert.ok(morningOf(MONDAY) > end);
});

for (const [day, date, expected] of [
  ['Tuesday', '2026-09-08', '2026-09-07'],
  ['Wednesday', '2026-09-09', '2026-09-08'],
  ['Thursday', '2026-09-10', '2026-09-09'],
  ['Friday', '2026-09-11', '2026-09-10'],
] as const) {
  test(`${day} still covers yesterday alone`, () => {
    const { start, days, label } = standupWindow(weekdays, morningOf(date));
    assert.equal(days, 1);
    assert.equal(start.toFormat('yyyy-MM-dd'), expected);
    assert.ok(!label.includes('–'), 'a single day must not render as a range');
  });
}

test('a Saturday working week leaves only Sunday for Monday to carry', () => {
  const sixDay = ConfigSchema.parse({
    timezone: IST,
    jobs: { reminder: { time: '09:00', daysOfWeek: [1, 2, 3, 4, 5, 6], enabled: true } },
  });
  const { days, start } = standupWindow(sixDay, morningOf(MONDAY));
  assert.equal(days, 2);
  assert.equal(start.toFormat('yyyy-MM-dd'), '2026-09-05');
});

test('a weekly Monday-only reminder covers the whole preceding week', () => {
  const weekly = ConfigSchema.parse({
    timezone: IST,
    jobs: { reminder: { time: '09:00', daysOfWeek: [1], enabled: true } },
  });
  assert.equal(standupWindow(weekly, morningOf(MONDAY)).days, 7);
});

test('no configured days falls back to yesterday rather than a week', () => {
  const none = ConfigSchema.parse({
    timezone: IST,
    jobs: { reminder: { time: '09:00', daysOfWeek: [], enabled: true } },
  });
  assert.equal(standupWindow(none, morningOf(MONDAY)).days, 1);
});

test('the window follows the configured timezone, not UTC', () => {
  // 20:30 UTC on Sunday is already Monday in IST, so the weekend span applies.
  const { days, start } = standupWindow(weekdays, DateTime.fromISO('2026-09-06T20:30:00Z'));
  assert.equal(days, 3);
  assert.equal(start.toFormat('yyyy-MM-dd'), '2026-09-04');
});

test('digestWindow spans several whole days when asked', () => {
  const { start, end, label } = digestWindow(weekdays, morningOf(MONDAY), 1, 3);
  assert.equal(start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-04 00:00');
  assert.equal(end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-06 23:59');
  assert.equal(label, 'Friday, 4 September – Sunday, 6 September');
});

test('digestWindow with the default span is unchanged', () => {
  const { start, end, label } = digestWindow(weekdays, morningOf(MONDAY), 1);
  assert.equal(start.toFormat('yyyy-MM-dd HH:mm'), '2026-09-06 00:00');
  assert.equal(end.toFormat('yyyy-MM-dd HH:mm'), '2026-09-06 23:59');
  assert.equal(label, 'Sunday, 6 September');
});

test('a channel spoken in on two days is folded into one entry', () => {
  const merged = mergeChannelActivity([
    [{ channel: 'dev', isDm: false, messages: 2, latest: 'friday note', permalink: 'p-fri' }],
    [{ channel: 'dev', isDm: false, messages: 3, latest: 'sunday note', permalink: 'p-sun' }],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.messages, 5);
  // The newest message wins, so the link points at the latest thing said.
  assert.equal(merged[0]!.latest, 'sunday note');
  assert.equal(merged[0]!.permalink, 'p-sun');
});

test('distinct channels across days are all kept', () => {
  const merged = mergeChannelActivity([
    [{ channel: 'dev', isDm: false, messages: 1, latest: 'a', permalink: 'p1' }],
    [{ channel: 'design', isDm: false, messages: 1, latest: 'b', permalink: 'p2' }],
  ]);
  assert.deepEqual(merged.map((m) => m.channel).sort(), ['design', 'dev']);
});
