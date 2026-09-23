import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactualSummary } from '../llm/factual-summary.js';
import type { Digest } from '../digest.js';

const base = {
  updates: [], mentionsAnswered: [], mentionsOpen: [], completed: [],
  statusChanges: [], newlyAssigned: [], slackReplied: [], slackAwaiting: [],
  slackActivity: [], meetings: [], dayOffset: 0,
  summary: null, total: 0,
} as unknown as Digest;

const update = (over: Record<string, unknown> = {}) => ({
  taskId: 1, taskName: 'A task', project: 'Report Designer', stage: 'Dev in progress',
  link: 'https://tw/app/tasks/1?c=9', taskLink: 'https://tw/app/tasks/1',
  text: '', prLinks: [], isDone: false, isBlocker: false, ...over,
});

test('a real day reads as something you could say out loud', () => {
  const digest = {
    ...base,
    updates: [
      update({ taskId: 1, taskName: 'Report Download Emails failing', stage: 'Dev in progress', isBlocker: true }),
      update({ taskId: 2, taskName: 'Backmerge 3.97.1', stage: 'QA signed off', isDone: true,
               prLinks: ['https://github.com/a/b/pull/1'], taskLink: 'https://tw/app/tasks/2' }),
    ],
    slackAwaiting: [{ permalink: 'https://s/1', author: 'Omar', isDm: false, channelName: 'dnrec' }],
    mentionsOpen: [{ link: 'https://tw/app/tasks/3?c=1', taskName: 'Sentry issues', author: 'Sam', stage: null }],
  } as unknown as Digest;

  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /Worked on 2 tasks/);
  assert.match(summary, /Dev done/);
  assert.match(summary, /Raised 1 PR/);
  assert.match(summary, /Blocked \/ waiting/);
  assert.match(summary, /Still open/);
});

test('each task carries its board column, for finding it on the shared screen', () => {
  const digest = { ...base, updates: [update({ taskName: 'Timepicker bug', stage: 'Ready for QA' })] } as unknown as Digest;
  assert.match(buildFactualSummary(digest)!, /Timepicker bug\|?.*_\(Ready for QA\)_/);
});

test('a task with no column still renders, just without one', () => {
  const digest = { ...base, updates: [update({ stage: null })] } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.ok(!summary.includes('_()_'));
});

test('task names are clickable links to the ticket', () => {
  const digest = { ...base, updates: [update({ taskName: 'X', taskLink: 'https://tw/app/tasks/42' })] } as unknown as Digest;
  assert.match(buildFactualSummary(digest)!, /<https:\/\/tw\/app\/tasks\/42\|X>/);
});

test('each PR says which ticket it belongs to', () => {
  const digest = {
    ...base,
    updates: [update({ taskName: 'Backmerge', taskLink: 'https://tw/app/tasks/7', prLinks: ['https://github.com/a/b/pull/1'] })],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /<https:\/\/github\.com\/a\/b\/pull\/1\|PR> on <https:\/\/tw\/app\/tasks\/7\|Backmerge>/);
});

test('two PRs on one ticket are numbered, not repeated', () => {
  const digest = {
    ...base,
    updates: [update({ taskName: 'Backmerge', prLinks: ['https://g/1', 'https://g/2'] })],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /PR 1/);
  assert.match(summary, /PR 2/);
  assert.match(summary, /Raised 2 PRs/);
});

test('answered questions are named so you can judge what to raise', () => {
  const digest = {
    ...base,
    mentionsAnswered: [{ author: 'Dev', taskName: 'Report permissions', link: 'https://tw/1', stage: null }],
    slackReplied: [{ author: 'Leo', isDm: true, channelName: 'x', permalink: 'https://s/2' }],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /Answered 2/);
  assert.match(summary, /Dev on <https:\/\/tw\/1\|Report permissions>/);
  assert.match(summary, /Leo in <https:\/\/s\/2\|DM>/);
});

test('open threads carry a link so you can jump straight there', () => {
  const digest = {
    ...base,
    slackAwaiting: [{ permalink: 'https://s/9', author: 'Omar', isDm: false, channelName: 'dnrec' }],
  } as unknown as Digest;
  assert.match(buildFactualSummary(digest)!, /<https:\/\/s\/9\|#dnrec> \(Omar\)/);
});

test('trailing asterisks Teamwork adds to titles are stripped', () => {
  const digest = { ...base, updates: [update({ taskName: 'UI Issue *' })] } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /\|UI Issue>/);
});

test('singular and plural are both right', () => {
  assert.match(buildFactualSummary({ ...base, updates: [update()] } as unknown as Digest)!, /Worked on 1 task\*/);
  assert.match(buildFactualSummary({ ...base, updates: [update(), update({ taskId: 2 })] } as unknown as Digest)!, /Worked on 2 tasks\*/);
});

test('a quiet day says nothing is outstanding rather than inventing work', () => {
  assert.match(buildFactualSummary({ ...base, updates: [update()] } as unknown as Digest)!, /nothing waiting on a reply/);
});

test('a long task list names every task — stand-up goes through each one', () => {
  const digest = { ...base, updates: Array.from({ length: 7 }, (_, i) => update({ taskId: i, taskName: `Task ${i}` })) } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  for (let i = 0; i < 7; i++) assert.match(summary, new RegExp(`Task ${i}`));
  assert.ok(!/Worked on[^\n]*\+\d+ more/.test(summary));
});

test('an empty digest produces no summary at all', () => {
  assert.equal(buildFactualSummary(base), null);
});

test('every entry is a bullet, and the tasks under Worked on are indented lines', () => {
  const summary = buildFactualSummary({ ...base, updates: [update()] } as unknown as Digest)!;
  assert.ok(summary.split('\n').every((l) => l.startsWith('• ') || l.startsWith('      ◦ ')));
  assert.ok(summary.startsWith('• '));
});

test('two comments on one task count as one task', () => {
  // Arjun commented twice on "Report Download Emails" and it was listed twice
  const digest = {
    ...base,
    updates: [
      update({ taskId: 27424881, taskName: 'Report Download Emails' }),
      update({ taskId: 27424881, taskName: 'Report Download Emails' }),
      update({ taskId: 27461134, taskName: 'Payload size' }),
    ],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /Worked on 2 tasks/);
  assert.equal(summary.match(/Report Download Emails/g)!.length, 1);
});

test('the blocked line de-duplicates too', () => {
  const digest = {
    ...base,
    updates: [
      update({ taskId: 1, taskName: 'Stuck thing', isBlocker: true }),
      update({ taskId: 1, taskName: 'Stuck thing', isBlocker: true }),
    ],
  } as unknown as Digest;
  assert.equal(buildFactualSummary(digest)!.match(/Stuck thing/g)!.length, 2); // once in Worked on, once in Blocked
});

test('two open comments on one task list the task once in Still open', () => {
  // 14 September: two unanswered comments from one person on one task read out twice.
  const ask = (at: string, author = 'Asha') =>
    ({ taskId: 1001, taskName: 'Convert media service *', link: `https://tw/app/tasks/1001?c=${at}`, author, stage: null, at });
  const digest = {
    ...base,
    mentionsOpen: [
      ask('1'), ask('2'), ask('3', 'Ravi'),
      { taskId: 1002, taskName: 'listAll method', link: 'https://tw/app/tasks/1002', author: 'Asha', stage: null, at: '4' },
    ],
  } as unknown as Digest;
  const open = buildFactualSummary(digest)!.split('\n').find((l) => l.includes('Still open'))!;
  assert.equal(open.match(/Convert media service/g)!.length, 1);
  assert.match(open, /Convert media service> \(Asha, Ravi\)/, 'everyone who asked is still named');
  assert.match(open, /listAll method/);
  assert.ok(!open.includes('more'));
});

test('replies in one place are one Answered entry, and the count says so', () => {
  const digest = {
    ...base,
    mentionsAnswered: [
      { taskId: 5, author: 'Dev', taskName: 'Report permissions', link: 'https://tw/1', stage: null },
      { taskId: 5, author: 'Dev', taskName: 'Report permissions', link: 'https://tw/2', stage: null },
    ],
    slackReplied: [
      { author: 'Nina', isDm: false, channelName: 'mobile_app', permalink: 'https://s/1' },
      { author: 'Nina', isDm: false, channelName: 'mobile_app', permalink: 'https://s/2' },
      { author: 'Leo', isDm: true, channelName: 'x', permalink: 'https://s/3' },
    ],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /Answered 3\*/);
  assert.equal(summary.match(/#mobile_app/g)!.length, 1);
  assert.equal(summary.match(/Report permissions/g)!.length, 1);
  assert.match(summary, /Leo in <https:\/\/s\/3\|DM>/);
});

test('DMs from two different people stay two entries', () => {
  const digest = {
    ...base,
    slackAwaiting: [
      { author: 'Omar', isDm: true, channelName: 'D1', permalink: 'https://s/1' },
      { author: 'Ivy', isDm: true, channelName: 'D2', permalink: 'https://s/2' },
    ],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /DM from Omar/);
  assert.match(summary, /DM from Ivy/);
});

test('the summary names where you talked and which calls happened', () => {
  const digest = {
    ...base,
    slackActivity: [
      { channel: '#team-frontend-dev', messages: 22, permalink: 'https://s/1', isDm: false, latest: '' },
      { channel: 'DM · Alice Doe', messages: 31, permalink: 'https://s/2', isDm: true, latest: '' },
    ],
    meetings: [{ channel: '#team-workflow-dev', author: 'Bob', text: 'call at 3:15', at: '', permalink: 'https://s/3', isDm: false }],
  } as unknown as Digest;
  const summary = buildFactualSummary(digest)!;
  assert.match(summary, /\*Calls\* — <https:\/\/s\/3\|#team-workflow-dev>/);
  assert.match(summary, /\*Talked in\*/);
  assert.match(summary, /#team-frontend-dev>\s?\(22\)/);
});

test('a day with only Slack activity still produces a summary', () => {
  const digest = {
    ...base,
    slackActivity: [{ channel: '#x', messages: 3, permalink: 'https://s/1', isDm: false, latest: '' }],
  } as unknown as Digest;
  assert.ok(buildFactualSummary(digest));
});
