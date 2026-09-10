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

test('a multi-day stand-up is titled by its span, not called yesterday', () => {
  const r = renderReminder(
    fakeResult({ overdue: 1 }), 'Asia/Kolkata', [], undefined, '\u2022 Closed 2 tasks',
    'Friday, 4 September \u2013 Sunday, 6 September', 3,
  );
  const json = JSON.stringify(r.blocks);
  assert.match(json, /Last 3 days/);
  assert.match(json, /Friday, 4 September/);
  assert.ok(!json.includes('Yesterday'), 'Monday must not call three days "yesterday"');
});

test('a single-day stand-up is still called yesterday', () => {
  const r = renderReminder(
    fakeResult({ overdue: 1 }), 'Asia/Kolkata', [], undefined, '\u2022 Closed 2 tasks',
    'Sunday, 6 September', 1,
  );
  assert.match(JSON.stringify(r.blocks), /Yesterday \u2014 Sunday, 6 September/);
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

/**
 * What the per-row controls cost. Question rows already span two blocks, so folding their
 * metadata up into the section leaves room for the buttons at no cost. Overdue rows are
 * one-block one-liners and gain a second block for the date picker and Complete — that is
 * the price of acting on them from Slack, and these tests pin exactly how big it is.
 */
import { renderReminder as renderForBudget } from '../slack/message.js';

const budgetItem = (i: number) => ({
  id: i,
  task: {
    id: 5100000 + i, name: `Task number ${i}`, projectName: 'Migrations',
    stageName: 'Ready for QA', dueDate: '2026-09-11',
  },
  match: { link: 'https://tw/x', detail: `Overdue by ${i} days` },
  assigneeNames: ['Mayank Pandey'],
});
const budgetGroup = (ruleId: string, label: string, n: number) => ({
  ruleId, label, items: Array.from({ length: n }, (_, i) => budgetItem(i + 1)),
});
const budgetResult = (overdue: number, asks: number) => ({
  recipient: { id: 'mayank', label: 'Mayank Pandey' },
  identity: { displayName: 'Mayank' },
  total: overdue + asks,
  groups: [
    budgetGroup('overdue', 'Overdue / due today', overdue),
    budgetGroup('awaiting-response', 'Awaiting my response', asks),
  ],
}) as never;

const render = (canReply: boolean, overdue = 12, asks = 12) =>
  renderForBudget(budgetResult(overdue, asks), 'Asia/Kolkata', [], undefined, null, null, 1, canReply);
const rowsShown = (canReply: boolean, overdue = 12, asks = 12) =>
  render(canReply, overdue, asks).blocks.filter((b) => JSON.stringify(b).includes('dismiss_task')).length;

test('question rows gain their buttons without costing a block', () => {
  assert.equal(render(true, 0, 12).blocks.length, render(false, 0, 12).blocks.length);
});

test('an ordinary morning still shows every row with the controls on', () => {
  // 11 overdue and 2 questions: the actual message of 11 September.
  assert.equal(rowsShown(true, 11, 2), 13);
});

test('a full message trims four rows, and says so rather than dropping them silently', () => {
  assert.equal(rowsShown(false), 24);
  assert.equal(rowsShown(true), 20);
  assert.match(JSON.stringify(render(true).blocks), /…and \d+ more/);
});

test('the controls never push a message past Slack\'s ceiling', () => {
  assert.ok(render(true).blocks.length <= 50);
});

test('every row that is shown carries its controls', () => {
  const actions = render(true).blocks.filter((b) => (b as { type?: string }).type === 'actions');
  assert.equal(actions.length, rowsShown(true));
});

test('an overdue row offers a date, Complete, Comment and Hide', () => {
  const actions = render(true, 1, 0).blocks.find((b) => (b as { type?: string }).type === 'actions') as Record<string, unknown>;
  const kinds = (actions.elements as Record<string, unknown>[]).map((e) => e.type === 'datepicker' ? 'date' : e.action_id);
  assert.deepEqual(kinds, ['date', 'complete_task', 'reply_task', 'dismiss_task']);
});

test('the date picker opens on the task\'s current due date', () => {
  const actions = render(true, 1, 0).blocks.find((b) => (b as { type?: string }).type === 'actions') as Record<string, unknown>;
  const picker = (actions.elements as Record<string, unknown>[]).find((e) => e.type === 'datepicker');
  assert.equal(picker!.initial_date, '2026-09-11');
});

test('without a token nothing changes: one Done button per row, no controls', () => {
  const blocks = render(false).blocks as Record<string, unknown>[];
  assert.equal(blocks.filter((b) => b.type === 'actions').length, 0);
  assert.ok(!JSON.stringify(blocks).includes('complete_task'));
});
