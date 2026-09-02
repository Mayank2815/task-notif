import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { actionRequested } from '../rules/action-requested.js';
import { awaitingResponse } from '../rules/awaiting-response.js';
import { overdue } from '../rules/overdue.js';
import { looksLikeRequest } from '../rules/shared.js';
import type { RuleContext } from '../rules/types.js';
import { buildIdentity, mentionsIdentity } from '../teamwork/identity.js';
import type { TeamworkComment, TeamworkTask } from '../teamwork/types.js';

const ME = 400001;
const OTHER = 400002;
const identity = buildIdentity({ id: ME, firstName: 'Priya', lastName: 'Pandey', email: 'mayankmp@example.com' }, ['PriyaS']);

const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata', includeDueToday: true });
const NOW = DateTime.fromISO('2026-09-02T09:00', { zone: 'Asia/Kolkata' });

function comment(over: Partial<TeamworkComment> = {}): TeamworkComment {
  return { id: 1, taskId: 10, authorId: OTHER, body: '', htmlBody: '', postedAt: '2026-09-01T10:00:00Z', url: 'https://tw/app/tasks/10?c=1', ...over };
}

function task(over: Partial<TeamworkTask> = {}): TeamworkTask {
  return { id: 10, name: 'A task', assigneeIds: [], followerIds: [], dueDate: null, url: 'https://tw/app/tasks/10', ...over };
}

function ctx(comments: TeamworkComment[], over: Partial<RuleContext> = {}): RuleContext {
  return { identity, config, now: NOW, comments, usersById: new Map(), ...over };
}

// --- mention matching: the three-Priya problem ---

test('matches the exact handle', () => {
  assert.equal(mentionsIdentity(comment({ body: '@PriyaS pls check' }), identity), true);
});

test('does not match a colleague whose handle shares the prefix', () => {
  assert.equal(mentionsIdentity(comment({ body: '@PriyaSha pls check' }), identity), false);
  assert.equal(mentionsIdentity(comment({ body: '@PriyaSin and @PriyaSi fyi' }), identity), false);
});

test('does not match a bare first name', () => {
  assert.equal(mentionsIdentity(comment({ body: '@Priya pls check' }), identity), false);
});

test('matches a markdown mention carrying the user id', () => {
  assert.equal(mentionsIdentity(comment({ body: 'Hi [@PriyaS](/app/people/400001) review passed' }), identity), true);
});

test('matches the atwho span markup Teamwork emits', () => {
  const htmlBody = '<div>Hi <span class="atwho-inserted" data-atwho-at-query="@may">@PriyaS</span>, please look</div>';
  assert.equal(mentionsIdentity(comment({ htmlBody, body: 'Hi @PriyaS, please look' }), identity), true);
});

test('matches by email address', () => {
  assert.equal(mentionsIdentity(comment({ body: 'cc mayankmp@example.com' }), identity), true);
});

test('an empty comment matches nothing', () => {
  assert.equal(mentionsIdentity(comment({ body: '', htmlBody: '' }), identity), false);
});

// --- request detection ---

test('a request phrase is recognised', () => {
  assert.equal(looksLikeRequest('@PriyaS Pls check'), true);
  assert.equal(looksLikeRequest('can we check this pls?'), true);
});

test('an FYI reporting completed work is not a request', () => {
  assert.equal(looksLikeRequest('I have updated the task details. Moving this back to sprint backlog.'), false);
  assert.equal(looksLikeRequest('The changes have been verified and are working as expected on UAT'), false);
});

// --- Rule A: awaiting my response ---

test('fires on my own task with an unanswered mention', () => {
  const t = task({ assigneeIds: [ME] });
  const match = awaitingResponse.evaluate(t, ctx([comment({ body: '@PriyaS any update?' })]));
  assert.ok(match);
  assert.equal(match.link, 'https://tw/app/tasks/10?c=1');
});

test('does not fire once I have replied after the mention', () => {
  const t = task({ assigneeIds: [ME] });
  const comments = [
    comment({ id: 1, body: '@PriyaS any update?' }),
    comment({ id: 2, authorId: ME, body: 'Working on it', postedAt: '2026-09-01T12:00:00Z' }),
  ];
  assert.equal(awaitingResponse.evaluate(t, ctx(comments)), null);
});

test('does not fire on a task assigned to someone else', () => {
  const t = task({ assigneeIds: [OTHER] });
  assert.equal(awaitingResponse.evaluate(t, ctx([comment({ body: '@PriyaS any update?' })])), null);
});

test('being an auto-subscribed follower is not enough to count as mine', () => {
  const t = task({ assigneeIds: [OTHER], followerIds: [ME] });
  assert.equal(awaitingResponse.evaluate(t, ctx([comment({ body: '@PriyaS any update?' })])), null);
});

// --- Rule B: action requested on someone else's task ---

test('fires when someone else owns the task and asks me to act', () => {
  const t = task({ assigneeIds: [OTHER] });
  const match = actionRequested.evaluate(t, ctx([comment({ body: '@PriyaS Pls check' })]));
  assert.ok(match);
});

test('does not fire on my own task — Rule A owns that case', () => {
  const t = task({ assigneeIds: [ME] });
  assert.equal(actionRequested.evaluate(t, ctx([comment({ body: '@PriyaS Pls check' })])), null);
});

test('does not fire on an FYI cc with no ask', () => {
  const t = task({ assigneeIds: [OTHER] });
  const body = 'The changes have been verified and are working as expected on UAT environment cc @MaxW @PriyaS';
  assert.equal(actionRequested.evaluate(t, ctx([comment({ body })])), null);
});

// --- Rule C: overdue ---

test('fires on a past-due task assigned to me', () => {
  const match = overdue.evaluate(task({ assigneeIds: [ME], dueDate: '2026-08-30' }), ctx([]));
  assert.match(match!.detail, /Overdue by 3 days/);
});

test('fires on a task due today when includeDueToday is on', () => {
  const match = overdue.evaluate(task({ assigneeIds: [ME], dueDate: '2026-09-02' }), ctx([]));
  assert.equal(match?.detail, 'Due today');
});

test('skips a task due today when includeDueToday is off', () => {
  const strict = ConfigSchema.parse({ timezone: 'Asia/Kolkata', includeDueToday: false });
  const match = overdue.evaluate(task({ assigneeIds: [ME], dueDate: '2026-09-02' }), ctx([], { config: strict }));
  assert.equal(match, null);
});

test('does not fire on a future due date, a missing one, or someone else\'s task', () => {
  assert.equal(overdue.evaluate(task({ assigneeIds: [ME], dueDate: '2026-09-10' }), ctx([])), null);
  assert.equal(overdue.evaluate(task({ assigneeIds: [ME], dueDate: null }), ctx([])), null);
  assert.equal(overdue.evaluate(task({ assigneeIds: [OTHER], dueDate: '2026-08-01' }), ctx([])), null);
});

test('links to the task itself, since no comment triggered it', () => {
  const match = overdue.evaluate(task({ assigneeIds: [ME], dueDate: '2026-08-30' }), ctx([]));
  assert.equal(match?.link, 'https://tw/app/tasks/10');
});
