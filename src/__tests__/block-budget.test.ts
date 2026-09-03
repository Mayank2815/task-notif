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

import { renderReminder } from '../slack/message.js';

const fakeResult = (counts: Record<string, number>): Parameters<typeof renderReminder>[0] => ({
  recipient: { id: 'alice', label: 'Alice Doe' },
  identity: { displayName: 'Alice Doe' },
  total: Object.values(counts).reduce((a, b) => a + b, 0),
  groups: Object.entries(counts).map(([ruleId, n]) => ({
    ruleId,
    label: ruleId,
    items: Array.from({ length: n }, (_, i) => ({
      task: { id: i, name: `Task ${i} *`, projectName: 'Proj', stageName: 'Ready for QA', dueDate: '2026-07-16', url: 'https://tw/1' },
      match: { ruleId, detail: 'Overdue by 49 days (due 16 Jul 2026)', link: 'https://tw/1' },
      ruleLabel: ruleId,
      assigneeNames: ['Alice Doe'],
    })),
  })),
}) as unknown as Parameters<typeof renderReminder>[0];

test('headings sit at the top level, where Slack renders them large', () => {
  // Inside an attachment Slack downgrades a header block to ordinary bold text,
  // which is why the sections looked identical to the rows beneath them.
  const r = renderReminder(fakeResult({ 'awaiting-response': 2, overdue: 3 }), 'Asia/Kolkata');
  assert.equal(r.attachments, undefined, 'no attachments — they suppress header sizing');
  const headers = (r.blocks as { type: string }[]).filter((b) => b.type === 'header');
  assert.ok(headers.length >= 2, 'a greeting header plus the "needs you today" heading');
});

test('yesterday leads the morning message, today follows', () => {
  const r = renderReminder(fakeResult({ overdue: 1 }), 'Asia/Kolkata', [], undefined, '• Closed 2 tasks');
  const json = JSON.stringify(r.blocks);
  assert.ok(json.indexOf('Yesterday') < json.indexOf('Needs you today'), 'stand-up half comes first');
  assert.match(json, /Closed 2 tasks/);
});

test('with no yesterday summary the message is just today', () => {
  const json = JSON.stringify(renderReminder(fakeResult({ overdue: 1 }), 'Asia/Kolkata').blocks);
  assert.ok(!json.includes('Yesterday'));
  assert.match(json, /Needs you today/);
});

test('the header carries a one-line tally', () => {
  const r = renderReminder(fakeResult({ overdue: 3 }), 'Asia/Kolkata');
  assert.match(JSON.stringify(r.blocks), /3 overdue/);
});

test('overdue rows show an age marker, not a repeated sentence', () => {
  const json = JSON.stringify(renderReminder(fakeResult({ overdue: 2 }), 'Asia/Kolkata').blocks);
  assert.match(json, /🔴 49d/);
  assert.ok(!json.includes('Overdue by 49 days'), 'the long form should be gone');
});

test('rows are numbered so they can be called out in stand-up', () => {
  const json = JSON.stringify(renderReminder(fakeResult({ overdue: 2 }), 'Asia/Kolkata').blocks);
  assert.match(json, /`1`/);
  assert.match(json, /`2`/);
});

test('the trailing asterisk is gone from titles', () => {
  const json = JSON.stringify(renderReminder(fakeResult({ overdue: 1 }), 'Asia/Kolkata').blocks);
  assert.match(json, /\|Task 0>/, 'link label should be the cleaned name');
  assert.ok(!json.includes('|Task 0 *>'), 'the trailing asterisk should not survive');
});

test('an empty day says so without inventing groups', () => {
  const r = renderReminder(fakeResult({}), 'Asia/Kolkata');
  assert.match(JSON.stringify(r.blocks), /All clear/);
  assert.equal(r.attachments, undefined);
});

test('every section heading is a header block, preceded by a divider', () => {
  const r = renderReminder(fakeResult({ 'awaiting-response': 1, overdue: 1 }), 'Asia/Kolkata');
  const blocks = r.blocks as { type: string }[];
  const groupHeaders = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'header').slice(1);
  for (const { i } of groupHeaders) {
    assert.equal(blocks[i - 1]!.type, 'divider', 'a divider should separate sections');
  }
});

test('a heading is plain text — Slack header blocks reject mrkdwn', () => {
  const r = renderReminder(fakeResult({ overdue: 1 }), 'Asia/Kolkata');
  const head = (r.blocks as { type: string; text: { type: string; text: string } }[]).filter((b) => b.type === 'header')[1]!;
  assert.equal(head.text.type, 'plain_text');
  assert.ok(!head.text.text.includes('*'), 'no bold markers in a header');
});
