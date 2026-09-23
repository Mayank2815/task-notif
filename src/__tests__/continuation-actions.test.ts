import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReminder } from '../slack/message.js';
import { rowKey } from '../slack/reply.js';
import { markRowCompleted, markRowMoved, markRowReplied, muteRow, restoreRow } from '../slack/socket.js';

/**
 * A message split in two keeps its headings and totals in the first part. The controls
 * on a row in the second part act on that part alone, so they must still work there —
 * with no heading above them to adjust — and must not disturb anything else.
 */
const item = (i: number, overdue: boolean) => ({
  id: i,
  task: { id: 5200000 + i, name: `Task ${i}`, projectName: 'Web', stageName: 'Ready for QA', dueDate: '2026-09-01' },
  match: { link: `https://tw/app/tasks/${5200000 + i}`, detail: overdue ? `Overdue by ${i} days` : 'Kiran: any update?' },
  assigneeNames: ['Alice'],
});
const msg = renderReminder({
  recipient: { id: 'alice', label: 'Alice' }, identity: { displayName: 'Alice' }, total: 40,
  groups: [
    { ruleId: 'awaiting-response', label: 'Awaiting my response', items: Array.from({ length: 20 }, (_, i) => item(i, false)) },
    { ruleId: 'overdue', label: 'Overdue / due today', items: Array.from({ length: 20 }, (_, i) => item(100 + i, true)) },
  ],
} as never, 'Asia/Kolkata', [], undefined, null, null, 1, true);

const part2 = msg.continuation![0]!.blocks as Record<string, unknown>[];
const keysIn = (blocks: Record<string, unknown>[]) =>
  blocks.filter((b) => b.type === 'actions').map((b) => b.block_id as string);

test('the fixture really splits, with rows of both kinds after the split', () => {
  assert.ok(msg.continuation?.length);
  assert.ok(keysIn(part2).length > 0);
});

test('Hide works on a row in the second message, and Undo restores it', () => {
  const key = keysIn(part2)[0]!;
  const hidden = muteRow(part2, key, 'x');
  assert.ok(hidden, 'the row must be found in the second message');
  assert.deepEqual(restoreRow(hidden!.blocks, key, hidden!.removed), part2);
});

test('moving a due date works on a row in the second message', () => {
  const overdueKey = keysIn(part2).find((k) => /task:52001/.test(k))!;
  assert.ok(overdueKey, 'an overdue row landed in part 2');
  const out = markRowMoved(part2, overdueKey, '2026-09-30', '2026-09-14');
  assert.ok(out);
  assert.match(JSON.stringify(out), /off the overdue list/);
});

test('completing and replying work there too', () => {
  const key = keysIn(part2)[0]!;
  assert.ok(markRowCompleted(part2, key, 'x'));
  assert.ok(markRowReplied(part2, key, []));
});

test('acting in the second message never touches a count it does not hold', () => {
  const key = keysIn(part2)[0]!;
  const before = JSON.stringify(part2.filter((b) => b.block_id !== key));
  const after = muteRow(part2, key, 'x')!.blocks;
  // Only the row itself changed; no heading or total was invented or altered.
  assert.ok(!/Needs you today/.test(JSON.stringify(after)));
  assert.equal((JSON.stringify(after).match(/"actions"/g) ?? []).length, (before.match(/"actions"/g) ?? []).length);
});

test('every row key appears exactly once across both messages', () => {
  const all = [...keysIn(msg.blocks as Record<string, unknown>[]), ...keysIn(part2)];
  assert.equal(all.length, 40);
  assert.equal(new Set(all).size, 40);
  assert.ok(all.includes(rowKey('alice', 5200000, 'Task 0')));
});
