import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { buildDigest } from '../digest.js';
import { teamworkTokenFor } from '../pipeline.js';
import type { TeamworkClient } from '../teamwork/client.js';

/**
 * 14 September: everyone's Teamwork data was read through one person's token. A recipient
 * who works on a DevOps board that token cannot see got "Nothing recorded" — her own token
 * found time logged and two tasks closed. People are now read with their own token.
 */
const config = ConfigSchema.parse({
  recipients: [
    { id: 'priya', label: 'Priya', teamworkUserId: 1, handles: ['PriyaS'], teamworkUserToken: 'priya-own' },
    { id: 'rohan', label: 'Rohan', teamworkUserId: 2, handles: ['RohanP'] },
    { id: 'kiran', label: 'Kiran', teamworkUserId: 3, handles: ['KiranM'], teamworkUserToken: '  ' },
  ],
});

test('someone who gave their own token is read with it', () => {
  assert.equal(teamworkTokenFor(config, 'priya', 'shared'), 'priya-own');
});

test('someone without one falls back to the shared token', () => {
  assert.equal(teamworkTokenFor(config, 'rohan', 'shared'), 'shared');
});

test('a blank stored token counts as none', () => {
  assert.equal(teamworkTokenFor(config, 'kiran', 'shared'), 'shared');
});

test('a token in the environment wins over the stored one', () => {
  process.env.TEAMWORK_USER_TOKEN_PRIYA = 'priya-env';
  try {
    assert.equal(teamworkTokenFor(config, 'priya', 'shared'), 'priya-env');
  } finally {
    delete process.env.TEAMWORK_USER_TOKEN_PRIYA;
  }
});

test('an unknown recipient is read with the shared token', () => {
  assert.equal(teamworkTokenFor(config, 'nobody', 'shared'), 'shared');
});

// --- tasks the sweep never indexed ------------------------------------------------------

/**
 * The sweep indexes open tasks, so a task closed since reads as "Task 5501". Six of one
 * person's seven tasks read that way on 14 September.
 */
const recipient = { id: 'alice', label: 'Alice', teamworkUserId: 42, handles: ['AliceA'] };
const monday = DateTime.fromISO('2026-09-14T09:00', { zone: 'Asia/Kolkata' });
const comment = (taskId: number, authorId: number, postedAt: string, body: string) =>
  ({ id: taskId * 10, taskId, authorId, body, htmlBody: body, postedAt, url: `https://tw/app/tasks/${taskId}?c=1` });
const workspace = () => ({
  commentsByTask: new Map([
    [5501, [comment(5501, 42, '2026-09-11T06:00:00Z', 'fixed and pushed')]],
    [5502, [comment(5502, 42, '2026-09-12T06:00:00Z', 'raised the PR')]],
  ]),
  tasksById: new Map(),
  usersById: new Map([[42, { id: 42, firstName: 'Alice', lastName: 'A' }]]),
  activity: [],
});

test('a task the sweep did not index is named from Teamwork, not shown as a number', async () => {
  const asked: number[] = [];
  const client = {
    siteUrl: 'https://tw',
    person: async () => null,
    timeLoggedBy: async () => [],
    task: async (id: number) => {
      asked.push(id);
      return id === 5501
        ? { id, name: '[BUG][High] Execute call does not encode the payload', projectName: 'Workflow Builder', url: `https://tw/app/tasks/${id}` }
        : null;
    },
  } as unknown as TeamworkClient;
  const d = await buildDigest(client, workspace() as never, ConfigSchema.parse({ timezone: 'Asia/Kolkata' }), recipient as never, monday, [], 1, [], [], 3);

  const named = d.updates.find((u) => u.taskId === 5501)!;
  assert.equal(named.taskName, '[BUG][High] Execute call does not encode the payload');
  assert.equal(named.project, 'Workflow Builder');
  assert.equal(named.taskLink, 'https://tw/app/tasks/5501');
  assert.deepEqual(asked.sort(), [5501, 5502], 'each missing task asked for once');
});

test('a task Teamwork will not return keeps its placeholder rather than breaking the digest', async () => {
  const client = {
    siteUrl: 'https://tw', person: async () => null, timeLoggedBy: async () => [],
    task: async () => { throw new Error('Teamwork 403'); },
  } as unknown as TeamworkClient;
  const d = await buildDigest(client, workspace() as never, ConfigSchema.parse({ timezone: 'Asia/Kolkata' }), recipient as never, monday, [], 1, [], [], 3);
  assert.equal(d.updates.length, 2);
  assert.ok(d.updates.every((u) => /^Task \d+$/.test(u.taskName)));
});
