import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReminder } from '../slack/message.js';
import { rowKey } from '../slack/reply.js';
import { adjustCounts, markRowCompleted, markRowMoved, markRowReplied, muteRow, restoreRow } from '../slack/socket.js';

/**
 * These run against a message the real renderer produced, not a hand-written fixture.
 * The count helper this replaced passed its tests for months against a heading format
 * the renderer had stopped using — so in practice no count ever went down.
 */
const item = (i: number, due = '2026-09-01') => ({
  id: i,
  task: { id: 5100000 + i, name: `Task ${i}`, projectName: 'Web', stageName: 'Ready for QA', dueDate: due },
  match: { link: `https://tw/app/tasks/${5100000 + i}`, detail: i < 3 ? 'Kiran: any update?' : `Overdue by ${i} days` },
  assigneeNames: ['Alice'],
});
const message = () => renderReminder({
  recipient: { id: 'alice', label: 'Alice' },
  identity: { displayName: 'Alice' },
  total: 4,
  groups: [
    { ruleId: 'awaiting-response', label: 'Awaiting my response', items: [item(1), item(2)] },
    { ruleId: 'overdue', label: 'Overdue / due today', items: [item(3), item(4)] },
  ],
} as never, 'Asia/Kolkata', [], undefined, null, null, 1, true).blocks as Record<string, unknown>[];

const question = rowKey('alice', 5100001, 'Task 1');
const overdue = rowKey('alice', 5100003, 'Task 3');
const TODAY = '2026-09-11';

const all = (blocks: Record<string, unknown>[]) => JSON.stringify(blocks);
const counts = (blocks: Record<string, unknown>[]) => {
  const s = all(blocks);
  return {
    total: /Needs you today · (\d+)/.exec(s)?.[1],
    replyTally: /(\d+) to reply/.exec(s)?.[1],
    overdueTally: /(\d+) overdue/.exec(s)?.[1],
    awaiting: /Awaiting my response\*\s+·\s+(\d+)/.exec(s)?.[1],
    overdueHeading: /Overdue \/ due today\*\s+·\s+(\d+)/.exec(s)?.[1],
  };
};

test('the fixture really is the message people get', () => {
  assert.deepEqual(counts(message()), { total: '4', replyTally: '2', overdueTally: '2', awaiting: '2', overdueHeading: '2' });
});

// --- replying ------------------------------------------------------------------------

test('an answered question leaves its section, with a line saying it was answered', () => {
  const out = markRowReplied(message(), question, ['Kiran Menon'])!;
  assert.match(all(out), /💬 Replied — Task 1 · Kiran Menon notified/);
  assert.ok(!all(out).includes(`"value":"${question}"`), 'no button left for a row already answered');
});

test('answering it brings every count down — heading, total and tally', () => {
  assert.deepEqual(counts(markRowReplied(message(), question, [])!), {
    total: '3', replyTally: '1', overdueTally: '2', awaiting: '1', overdueHeading: '2',
  });
});

test('a reply on an overdue task marks it but leaves it — it is still overdue', () => {
  const out = markRowReplied(message(), overdue, ['Kiran Menon'])!;
  assert.match(all(out), /you replied · Kiran Menon notified/);
  assert.deepEqual(counts(out), counts(message()));
  assert.ok(all(out).includes('complete_task'), 'its controls stay');
});

test('replying twice on an overdue row replaces the mark instead of stacking it', () => {
  const twice = markRowReplied(markRowReplied(message(), overdue, ['A'])!, overdue, ['B'])!;
  assert.equal((all(twice).match(/you replied/g) ?? []).length, 1);
});

// --- moving the date -----------------------------------------------------------------

test('moved past today, a task leaves the overdue section', () => {
  const out = markRowMoved(message(), overdue, '2026-09-18', TODAY)!;
  assert.match(all(out), /Task 3\* — moved to Fri 18 Sep, off the overdue list/);
  assert.deepEqual(counts(out), { total: '3', replyTally: '2', overdueTally: '1', awaiting: '2', overdueHeading: '1' });
});

test('the note keeps a date picker, so a wrong pick is fixed by picking again', () => {
  const out = markRowMoved(message(), overdue, '2026-09-18', TODAY)!;
  const note = out.find((b) => b.block_id === overdue)!;
  assert.equal((note.accessory as { type: string; initial_date: string }).type, 'datepicker');
  assert.equal((note.accessory as { initial_date: string }).initial_date, '2026-09-18');
});

test('picking again changes the note, and does not take the count down twice', () => {
  const once = markRowMoved(message(), overdue, '2026-09-18', TODAY)!;
  const again = markRowMoved(once, overdue, '2026-09-25', TODAY)!;
  assert.match(all(again), /moved to Fri 25 Sep/);
  assert.ok(!all(again).includes('18 Sep'));
  assert.deepEqual(counts(again), counts(once));
});

test('moved to today it is still due today, so it stays where it is', () => {
  const out = markRowMoved(message(), overdue, TODAY, TODAY)!;
  assert.match(all(out), /moved to Fri 11 Sep/);
  assert.deepEqual(counts(out), counts(message()));
  assert.ok(out.some((b) => b.type === 'actions' && b.block_id === overdue), 'its controls stay');
});

// --- finishing and hiding ----------------------------------------------------------------

test('a completed task leaves, and the counts follow', () => {
  const out = markRowCompleted(message(), overdue, 'Task 3')!;
  assert.match(all(out), /Completed in Teamwork — Task 3/);
  assert.deepEqual(counts(out), { total: '3', replyTally: '2', overdueTally: '1', awaiting: '2', overdueHeading: '1' });
});

test('hiding a row brings the counts down, and undo puts them back', () => {
  const original = message();
  const hidden = muteRow(original, question, 'Task 1')!;
  assert.deepEqual(counts(hidden.blocks), { total: '3', replyTally: '1', overdueTally: '2', awaiting: '1', overdueHeading: '2' });
  assert.deepEqual(restoreRow(hidden.blocks, question, hidden.removed), original);
});

test('a count never goes below zero', () => {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: '💬  *Awaiting my response*  ·  0' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'row\nbody' } },
  ];
  assert.match(all(adjustCounts(blocks, 1, -1)), /·  0/);
});

test('a Slack heading in the format actually sent is counted too', () => {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: '💬  *Slack — still unanswered*  ·  5' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'row\nbody' } },
  ];
  assert.match(all(adjustCounts(blocks, 1, -1)), /still unanswered\*  ·  4/);
});
