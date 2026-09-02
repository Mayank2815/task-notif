import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigSchema } from '../config/schema.js';
import { buildPrompt } from '../llm/standup.js';
import type { Digest } from '../digest.js';

const empty = {
  updates: [], mentionsAnswered: [], mentionsOpen: [], completed: [],
  statusChanges: [], newlyAssigned: [], slackReplied: [], slackAwaiting: [],
  summary: null, total: 0,
} as unknown as Digest;

const withDm = {
  ...empty,
  slackAwaiting: [
    { isDm: true, author: 'Dev', channelName: 'x', text: 'salary discussion, private', answered: false },
    { isDm: false, author: 'Omar', channelName: 'client_alpha', text: 'please check the deploy', answered: false },
  ],
} as unknown as Digest;

test('DM contents are withheld from the model by default', () => {
  const prompt = buildPrompt(withDm, false);
  assert.ok(!prompt.includes('salary discussion'));
  assert.ok(prompt.includes('DM from Dev (content withheld)'));
});

test('channel messages are included — they are already semi-public', () => {
  const prompt = buildPrompt(withDm, false);
  assert.ok(prompt.includes('please check the deploy'));
  assert.ok(prompt.includes('#client_alpha'));
});

test('opting in sends DM text too', () => {
  assert.ok(buildPrompt(withDm, true).includes('salary discussion'));
});

test('the prompt forbids inventing facts', () => {
  const prompt = buildPrompt(empty, false);
  assert.match(prompt, /Do not invent/i);
});

test('an empty day says so rather than leaving the model to improvise', () => {
  assert.ok(buildPrompt(empty, false).includes('(no recorded activity today)'));
});

test('PR links and done/blocker tags reach the model', () => {
  const digest = {
    ...empty,
    updates: [{
      taskName: 'Backmerge 3.97.1', project: 'Automation Designer', text: 'PRs raised',
      prLinks: ['https://github.com/a/b/pull/1'], isDone: true, isBlocker: false,
    }],
  } as unknown as Digest;
  const prompt = buildPrompt(digest, false);
  assert.match(prompt, /marked done/);
  assert.match(prompt, /1 PR link/);
});

test('Gemini is off by default — the local summary needs no network or key', () => {
  const config = ConfigSchema.parse({});
  assert.equal(config.standupSummaryEnabled, false);
  assert.equal(config.standupSummaryIncludeDmText, false);
});
