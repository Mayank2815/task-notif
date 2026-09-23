import assert from 'node:assert/strict';
import test from 'node:test';
import { nothingToSend } from '../deliver.js';
import { renderReminder } from '../slack/message.js';

/**
 * 14 September: someone moved every overdue date forward and hid the rest, straight from
 * Slack. Their list was empty — and the reminder was about to skip them entirely, taking
 * the next morning's stand-up with it.
 */

test('an empty list with a stand-up is still sent', () => {
  assert.equal(nothingToSend(0, true, false), false);
});

test('an empty list and no stand-up is skipped, as before', () => {
  assert.equal(nothingToSend(0, false, false), true);
});

test('anything on the list is always sent', () => {
  assert.equal(nothingToSend(3, false, false), false);
});

test('sendWhenEmpty still forces a message', () => {
  assert.equal(nothingToSend(0, false, true), false);
});

const standupOnly = () => renderReminder({
  recipient: { id: 'alice', label: 'Alice' },
  identity: { displayName: 'Alice' },
  total: 0,
  groups: [],
} as never, 'Asia/Kolkata', [], undefined, '• *Worked on 2 tasks* · 3h logged — A; B', 'Monday, 14 September', 1, true);

test('the stand-up is in the message', () => {
  assert.match(JSON.stringify(standupOnly().blocks), /Worked on 2 tasks/);
});

test('an empty list says so instead of showing a count of zero', () => {
  const s = JSON.stringify(standupOnly().blocks);
  assert.match(s, /Nothing needs you today/);
  assert.ok(!/Needs you today · 0/.test(s));
});

test('no block is left with empty text, which Slack would reject with the whole message', () => {
  for (const b of standupOnly().blocks as Record<string, any>[]) {
    if (b.type === 'section' || b.type === 'header') assert.ok(String(b.text?.text ?? '').length > 0, `empty ${b.type}`);
    if (b.type === 'context') for (const e of b.elements ?? []) assert.ok(e.type === 'image' || String(e.text ?? '').length > 0, 'empty context');
  }
});

test('the notification reads as a stand-up, not "0 items need your attention"', () => {
  assert.match(standupOnly().text, /^Your stand-up — /);
});
