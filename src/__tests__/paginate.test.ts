import assert from 'node:assert/strict';
import test from 'node:test';
import { MESSAGE_BLOCKS, paginate, toUnits } from '../slack/paginate.js';

type Block = Record<string, unknown>;
const header = (t: string): Block => ({ type: 'header', text: { type: 'plain_text', text: t } });
const heading = (label: string, n: number): Block => ({ type: 'section', text: { type: 'mrkdwn', text: `💬  *${label}*  ·  ${n}` } });
const row = (i: number): Block[] => [
  { type: 'section', text: { type: 'mrkdwn', text: `\`${i}\` *Task ${i}*` } },
  { type: 'actions', block_id: `alice|task:${i}|Task ${i}`, elements: [{ type: 'button', action_id: 'dismiss_task', value: `alice|task:${i}|Task ${i}` }] },
];
const text = (b: Block) => JSON.stringify(b);
const all = (m: { blocks: unknown[]; continuation?: { blocks: unknown[] }[] }) =>
  [m.blocks, ...(m.continuation ?? []).map((c) => c.blocks)] as Block[][];

/** A reminder too big for one message: an intro, then 40 task rows of two blocks each. */
const big = (): Block[] => [header('Good morning, Alice'), heading('Awaiting my response', 40), ...Array.from({ length: 40 }, (_, i) => row(i + 1)).flat()];

test('a message that fits is returned exactly as it was', () => {
  const small = { text: 't', blocks: [header('x'), ...row(1)] };
  assert.deepEqual(paginate(small), small);
});

test('a message over the ceiling becomes several, none over it', () => {
  const out = paginate({ text: 't', blocks: big() });
  assert.ok(out.continuation && out.continuation.length >= 1);
  for (const part of all(out)) assert.ok(part.length <= MESSAGE_BLOCKS, `a part has ${part.length} blocks`);
});

test('nothing is dropped — every row arrives, once, in order', () => {
  const ids = all(paginate({ text: 't', blocks: big() }))
    .flat().filter((b) => b.type === 'actions').map((b) => b.block_id as string);
  assert.deepEqual(ids, Array.from({ length: 40 }, (_, i) => `alice|task:${i + 1}|Task ${i + 1}`));
});

test('a row is never separated from its buttons', () => {
  for (const part of all(paginate({ text: 't', blocks: big() }))) {
    assert.notEqual(part[0]?.type === 'actions' ? 'orphan' : 'ok', 'orphan');
    const last = part.filter((b) => b.type !== 'context').pop();
    assert.notEqual(last?.type, 'section', 'a part must not end on a row whose buttons went to the next');
  }
});

test('a part never ends on a heading with nothing under it', () => {
  const blocks = [header('intro'), ...Array.from({ length: 23 }, (_, i) => row(i)).flat(), heading('Overdue', 5), ...Array.from({ length: 5 }, (_, i) => row(100 + i)).flat()];
  for (const part of all(paginate({ text: 't', blocks }))) {
    const content = part.filter((b) => !(b.type === 'context' && /Continued|Part \d/.test(text(b))));
    assert.ok(!/Overdue/.test(text(content[content.length - 1]!)), 'the Overdue heading must travel with its first row');
  }
});

test('each part says where it sits', () => {
  const parts = all(paginate({ text: 't', blocks: big() }));
  assert.match(text(parts[0]![parts[0]!.length - 1]!), /Continued in the next message: part 2 of 2/);
  assert.match(text(parts[1]![0]!), /Part 2 of 2, continued/);
});

test('the notification text names the part too', () => {
  assert.equal(paginate({ text: '13 items need your attention', blocks: big() }).continuation![0]!.text, '13 items need your attention (part 2 of 2)');
});

test('a row\'s metadata line stays with the row', () => {
  const units = toUnits([
    { type: 'section', text: { type: 'mrkdwn', text: 'row' }, accessory: { type: 'button' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Web · due today' }] },
  ]);
  assert.equal(units.length, 1);
});
