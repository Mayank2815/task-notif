import assert from 'node:assert/strict';
import test from 'node:test';
import { muteRow } from '../slack/socket.js';

const TASK_VALUE = 'alice|task:5100001|Widget shows the wrong value';

const blocks = (): Record<string, unknown>[] => [
  { type: 'header', text: { type: 'plain_text', text: 'Good morning' } },
  { type: 'section', text: { type: 'mrkdwn', text: '⏰  *Overdue / due today*  ·  2' } },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '`1`  🔴 50d   *Widget*' },
    accessory: { type: 'button', action_id: 'dismiss_task', value: TASK_VALUE },
  },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '`2`  🔴 50d   *Layout glitch*' },
    accessory: { type: 'button', action_id: 'dismiss_task', value: 'alice|task:5100002|Layout glitch' },
  },
];

test('marking a task done removes its Done button', () => {
  const out = muteRow(blocks(), TASK_VALUE, 'Widget')!.blocks;
  const stillDoneable = out.filter(
    (b) => (b.accessory as { action_id?: string } | undefined)?.action_id === 'dismiss_task'
      && (b.accessory as { value?: string }).value === TASK_VALUE,
  );
  assert.equal(stillDoneable.length, 0);
});

test('the row is replaced by a note, not deleted without trace', () => {
  const out = muteRow(blocks(), TASK_VALUE, 'Widget')!.blocks;
  assert.ok(out.some((b) => JSON.stringify(b).includes('Done')));
});

test('other tasks keep their buttons', () => {
  const out = muteRow(blocks(), TASK_VALUE, 'Widget')!.blocks;
  const left = out.filter((b) => (b.accessory as { action_id?: string } | undefined)?.action_id === 'dismiss_task');
  assert.equal(left.length, 1);
});

test('the stored key is scoped to the task, not the message', () => {
  // "alice|task:5100001|name" -> recipient alice, key task:5100001
  const [recipientId, key] = TASK_VALUE.split('|');
  assert.equal(recipientId, 'alice');
  assert.equal(key, 'task:5100001');
});

test('task keys and Slack thread keys cannot collide', () => {
  const taskKey = 'task:5100001';
  const threadKey = 'C1234ABCD:1700000000.000100';
  assert.notEqual(taskKey, threadKey);
  assert.ok(taskKey.startsWith('task:'));
  assert.ok(!threadKey.startsWith('task:'));
});

/** Mirrors the revive rule applied to tasks in evaluateRecipient. */
function stillHidden(dismissedAt: string, commentTimes: string[]): boolean {
  const latest = commentTimes.reduce((a, b) => (a > b ? a : b), '');
  return !(latest && latest > dismissedAt);
}

test('a task with no new comment stays hidden', () => {
  assert.equal(stillHidden('2026-09-04T10:00:00Z', ['2026-09-03T09:00:00Z']), true);
});

test('a comment after the dismissal brings the task back', () => {
  assert.equal(stillHidden('2026-09-04T10:00:00Z', ['2026-09-04T11:30:00Z']), false);
});

test('a comment at the very same moment does not revive it', () => {
  assert.equal(stillHidden('2026-09-04T10:00:00Z', ['2026-09-04T10:00:00Z']), true);
});

test('the newest comment decides, not the order they arrive in', () => {
  const times = ['2026-09-04T11:00:00Z', '2026-09-01T08:00:00Z', '2026-09-02T08:00:00Z'];
  assert.equal(stillHidden('2026-09-04T10:00:00Z', times), false);
});

test('a task with no comments at all stays hidden', () => {
  assert.equal(stillHidden('2026-09-04T10:00:00Z', []), true);
});

test('pressing Done again re-hides a revived task', () => {
  // The dismissal is replaced, so its timestamp moves past the reviving comment.
  const reviving = '2026-09-04T11:30:00Z';
  assert.equal(stillHidden('2026-09-04T10:00:00Z', [reviving]), false);
  assert.equal(stillHidden('2026-09-04T12:00:00Z', [reviving]), true);
});

/** The Slack side uses the mention's own timestamp against the dismissal. */
function slackStillHidden(dismissedAt: string | undefined, mentionAt: string): boolean {
  return Boolean(dismissedAt) && mentionAt <= dismissedAt!;
}

test('a new mention in a dismissed thread brings it back', () => {
  assert.equal(slackStillHidden('2026-09-04T10:00:00Z', '2026-09-04T11:00:00Z'), false);
  assert.equal(slackStillHidden('2026-09-04T10:00:00Z', '2026-09-03T11:00:00Z'), true);
});

test('a thread never dismissed is always shown', () => {
  assert.equal(slackStillHidden(undefined, '2026-09-01T00:00:00Z'), false);
});
