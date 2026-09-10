import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactualSummary } from '../llm/factual-summary.js';
import { buildPrompt } from '../llm/standup.js';
import type { Digest } from '../digest.js';

/** A person who closed one task and has nothing open in Teamwork. */
const digest = (): Digest => ({
  recipient: { id: 'shriyam', label: 'Shriyam Gera' },
  label: 'Tuesday, 8 September',
  updates: [],
  completed: [{ taskId: 1, taskName: 'Fix the header', taskLink: 'https://tw/1', project: 'Web', stage: null }],
  statusChanges: [],
  newlyAssigned: [],
  mentionsOpen: [],
  mentionsAnswered: [],
  slackAwaiting: [],
  slackReplied: [],
  slackActivity: [],
  meetings: [],
  summary: null,
  total: 1,
} as unknown as Digest);

test('with Slack connected, "nothing waiting" is a claim we can stand behind', () => {
  const out = buildFactualSummary(digest(), true)!;
  assert.match(out, /nothing waiting on a reply/);
  assert.ok(!out.includes('not connected'));
});

test('without Slack, the summary never claims nothing is waiting', () => {
  const out = buildFactualSummary(digest(), false)!;
  assert.ok(
    !/nothing waiting on a reply/.test(out),
    'an absolute claim must not be made from Teamwork alone',
  );
});

test('without Slack, the summary scopes what it actually looked at', () => {
  const out = buildFactualSummary(digest(), false)!;
  assert.match(out, /nothing waiting in Teamwork/);
});

test('without Slack, the reader is told the Slack half is missing', () => {
  const out = buildFactualSummary(digest(), false)!;
  assert.match(out, /Slack is not connected/);
});

test('the caveat is absent for a connected account', () => {
  assert.ok(!buildFactualSummary(digest(), true)!.includes('Slack is not connected'));
});

test('connected is the default, so existing callers are unchanged', () => {
  assert.equal(buildFactualSummary(digest()), buildFactualSummary(digest(), true));
});

test('a person with open Teamwork work still gets the caveat when Slack is missing', () => {
  const d = digest();
  (d as { mentionsOpen: unknown[] }).mentionsOpen = [
    { taskName: 'Fix the header', link: 'https://tw/1', author: 'Dev', text: 'any update?' },
  ];
  const out = buildFactualSummary(d, false)!;
  assert.match(out, /Still open/);
  assert.match(out, /Slack is not connected/, 'the list must not read as complete');
});

test('Gemini is told not to claim completeness when Slack was not searched', () => {
  const p = buildPrompt(digest(), false, false);
  assert.match(p, /Slack was NOT searched/);
  assert.match(p, /do not claim/);
});

test('the Gemini prompt is unchanged for a connected account', () => {
  assert.ok(!buildPrompt(digest(), false, true).includes('Slack was NOT searched'));
  assert.equal(buildPrompt(digest(), false), buildPrompt(digest(), false, true));
});
