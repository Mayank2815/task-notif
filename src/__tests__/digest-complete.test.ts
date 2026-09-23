import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDigest } from '../slack/digest-message.js';

/**
 * Friday 11 September, measured: one person's weekly had 51 "other changes" and showed
 * 12; another's lost thirteen blocks off the end to the fifty-block ceiling. These pin that
 * every item now arrives, in as many messages as it takes.
 */
const n = (count: number) => Array.from({ length: count }, (_, i) => i);
const week = () => ({
  recipient: { id: 'alice', label: 'Alice' },
  identity: { displayName: 'Alice' },
  dayLabel: 'Monday, 7 September – Friday, 11 September',
  updates: n(29).map((i) => ({
    taskId: i, taskName: `Update ${i}`, taskLink: `https://tw/app/tasks/${i}`, link: `https://tw/app/tasks/${i}?c=1`,
    project: 'Web', text: `comment ${i} `.repeat(20), at: '2026-09-10T10:00:00Z', isDone: false, isBlocker: false, prLinks: [],
  })),
  completed: n(18).map((i) => ({ taskId: i, taskName: `Closed ${i}`, project: 'Web', stage: null, link: `https://tw/c/${i}`, at: '' })),
  statusChanges: n(51).map((i) => ({ description: `Moved change ${i} from Dev in Progress to Ready for QA on a long task name`, at: '2026-09-09T10:00:00Z', link: null })),
  newlyAssigned: n(15).map((i) => ({ taskId: i, taskName: `New ${i}`, project: 'Web', stage: null, link: `https://tw/n/${i}` })),
  mentionsOpen: n(8).map((i) => ({ taskId: i, taskName: `Asked ${i}`, link: `https://tw/a/${i}`, author: 'Kiran', text: `question ${i}`, at: '2026-09-10T09:00:00Z' })),
  mentionsAnswered: n(4).map((i) => ({ taskId: i, taskName: `Answered ${i}`, link: `https://tw/r/${i}`, author: 'Kiran', text: '', at: '' })),
  slackReplied: [], slackAwaiting: [], slackActivity: [], meetings: [],
  dayOffset: 0, total: 125, summary: '• *Worked on 29 tasks* — …',
}) as never;

const parts = () => {
  const msg = renderDigest(week(), 'Asia/Kolkata', undefined, 'week');
  return [msg.blocks, ...(msg.continuation ?? []).map((c) => c.blocks)] as Record<string, unknown>[][];
};
const everything = () => JSON.stringify(parts());

test('a heavy week arrives as more than one message, each inside the ceiling', () => {
  assert.ok(parts().length > 1);
  for (const p of parts()) assert.ok(p.length <= 50, `a part has ${p.length} blocks`);
});

test('every single item is in there', () => {
  const all = everything();
  for (const i of n(29)) assert.ok(all.includes(`Update ${i}`), `update ${i} missing`);
  for (const i of n(18)) assert.ok(all.includes(`Closed ${i}`), `closed ${i} missing`);
  for (const i of n(51)) assert.ok(all.includes(`Moved change ${i} `), `change ${i} missing`);
  for (const i of n(15)) assert.ok(all.includes(`New ${i}`), `new ${i} missing`);
  for (const i of n(8)) assert.ok(all.includes(`Asked ${i}`), `asked ${i} missing`);
  for (const i of n(4)) assert.ok(all.includes(`Answered ${i}`), `answered ${i} missing`);
});

test('nothing is summarised away or trimmed off', () => {
  assert.ok(!/…and \d+ more/.test(everything()));
  assert.ok(!/trimmed to fit/.test(everything()));
});

test('every section stays inside Slack\'s 3,000 characters', () => {
  for (const p of parts()) for (const b of p) {
    const t = (b.text as { text?: string } | undefined)?.text ?? '';
    assert.ok(t.length <= 3000, `a section is ${t.length} characters`);
  }
});

test('a light day is still one message', () => {
  const light = { ...(week() as object), updates: [], completed: [], statusChanges: [], newlyAssigned: [], mentionsOpen: [], mentionsAnswered: [], total: 1 };
  assert.equal(renderDigest(light as never, 'Asia/Kolkata').continuation, undefined);
});
