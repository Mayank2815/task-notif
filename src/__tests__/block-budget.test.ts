import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_BLOCKS, assembleWithBudget, type BlockSection } from '../slack/message.js';

const section = (items: number, blocksPerItem = 2): BlockSection => ({
  header: [{ type: 'divider' }, { type: 'section' }],
  items: Array.from({ length: items }, () => Array.from({ length: blocksPerItem }, () => ({ type: 'section' }))),
  more: (hidden: number) => ({ type: 'context', hidden }),
});

const intro = [{ type: 'header' }, { type: 'context' }];

test('a message that already fits is left alone', () => {
  const blocks = assembleWithBudget(intro, [section(3)]);
  assert.equal(blocks.length, 2 + 2 + 6);
});

test('the real shape that Slack rejected now fits', () => {
  // 19 tasks over 3 groups plus 8 Slack rows — the message that returned invalid_blocks
  const blocks = assembleWithBudget(intro, [section(4), section(4), section(12), section(8)]);
  assert.ok(blocks.length <= MAX_BLOCKS, `expected <= ${MAX_BLOCKS}, got ${blocks.length}`);
});

test('trimming takes from the longest section, not the first', () => {
  const blocks = assembleWithBudget(intro, [section(2), section(30)]);
  assert.ok(blocks.length <= MAX_BLOCKS);
  // The small section survives intact: header + both rows, and no "more" note for it.
  assert.equal(blocks.filter((b) => (b as { hidden?: number }).hidden !== undefined).length, 1);
});

test('a trimmed section says how many were hidden', () => {
  const blocks = assembleWithBudget(intro, [section(40)]);
  const note = blocks.find((b) => (b as { hidden?: number }).hidden !== undefined) as { hidden: number };
  assert.ok(note.hidden > 0);
});

test('rows are never split across the boundary', () => {
  // Each row is 3 blocks; the total must stay a whole number of rows.
  const blocks = assembleWithBudget(intro, [section(30, 3)]);
  assert.equal((blocks.length - intro.length - 2 - 1) % 3, 0);
});

test('an empty section contributes nothing, not a bare header', () => {
  const blocks = assembleWithBudget(intro, [section(0), section(2)]);
  assert.equal(blocks.length, 2 + 2 + 4);
});
