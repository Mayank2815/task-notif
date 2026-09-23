import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { ConfigSchema } from '../config/schema.js';
import { buildDigest, hoursAndMinutes, type Digest } from '../digest.js';
import { buildFactualSummary } from '../llm/factual-summary.js';
import { buildPrompt } from '../llm/standup.js';
import { renderDigest } from '../slack/digest-message.js';
import { TeamworkClient } from '../teamwork/client.js';

/**
 * 14 September: a Monday stand-up said "Worked on 1 task" for someone who had logged time
 * on eight — about eight hours, including three on the task they asked about. Time logs
 * were never read. These pin that they are, and how they are shown.
 */

test('durations read the way they are said', () => {
  assert.equal(hoursAndMinutes(180), '3h');
  assert.equal(hoursAndMinutes(78), '1h 18m');
  assert.equal(hoursAndMinutes(36), '36m');
  assert.equal(hoursAndMinutes(0), '0m');
});

const base = {
  recipient: { id: 'alice', label: 'Alice' },
  identity: { displayName: 'Alice' },
  dayLabel: 'Friday, 11 September – Sunday, 13 September',
  updates: [{
    taskId: 1, taskName: 'Hibernate modal', project: 'Systemwide', stage: 'BA Signed-Off', link: 'https://tw/c/1',
    taskLink: 'https://tw/app/tasks/1', at: '2026-09-11T03:44:00Z', text: 'merged', prLinks: [], isDone: false, isBlocker: false,
  }],
  completed: [], statusChanges: [], newlyAssigned: [], mentionsOpen: [], mentionsAnswered: [],
  slackReplied: [], slackAwaiting: [], slackActivity: [], meetings: [], dayOffset: 1, summary: null, total: 4,
};
const timeLogged: Digest['timeLogged'] = [
  { taskId: 2, taskName: 'Restore page state', project: 'Page Designer', stage: null, link: 'https://tw/app/tasks/2', minutes: 180 },
  { taskId: 3, taskName: 'Portal Sentry issues', project: 'Expertly', stage: null, link: 'https://tw/app/tasks/3', minutes: 75 },
  { taskId: 1, taskName: 'Hibernate modal', project: 'Systemwide', stage: null, link: 'https://tw/app/tasks/1', minutes: 30 },
];
const withTime = { ...base, timeLogged } as unknown as Digest;
const withoutTime = base as unknown as Digest;

test('a task with only logged time counts as worked on', () => {
  const s = buildFactualSummary(withTime)!;
  assert.match(s, /\*Worked on 3 tasks\*/);
  assert.match(s, /Restore page state/);
  assert.match(s, /Portal Sentry issues/);
});

test('a task both commented on and timed is counted once', () => {
  const s = buildFactualSummary(withTime)!;
  assert.equal((s.match(/Hibernate modal/g) ?? []).length, 1);
});

/** The "Worked on" entry: its heading line and every task line under it. */
const workedBlock = (summary: string) => {
  const lines = summary.split('\n');
  const start = lines.findIndex((l) => l.includes('Worked on'));
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((l) => l.startsWith('• '));
  return [lines[start]!, ...(stop === -1 ? rest : rest.slice(0, stop))];
};

test('the most time comes first, and each shows its duration and the total', () => {
  const [head, ...tasks] = workedBlock(buildFactualSummary(withTime)!);
  assert.match(head!, /\*Worked on 3 tasks\* · 4h 45m logged$/);
  assert.equal(tasks.length, 3);
  assert.match(tasks[0]!, /Restore page state>.* · 3h$/);
  assert.match(tasks[1]!, /Portal Sentry issues>.* · 1h 15m$/);
  assert.match(tasks[2]!, /Hibernate modal>/);
});

test('every task is named — no "+N more" in Worked on', () => {
  const many: Digest['timeLogged'] = Array.from({ length: 9 }, (_, i) => ({
    taskId: 100 + i, taskName: `Task number ${i}`, project: 'Web', stage: null, link: `https://tw/app/tasks/${100 + i}`, minutes: 60 - i,
  }));
  const [head, ...tasks] = workedBlock(buildFactualSummary({ ...base, updates: [], timeLogged: many } as unknown as Digest)!);
  assert.match(head!, /Worked on 9 tasks/);
  assert.equal(tasks.length, 9);
  for (let i = 0; i < 9; i++) assert.ok(tasks.some((t) => t.includes(`Task number ${i}`)), `task ${i} missing`);
  assert.ok(![head!, ...tasks].join('').includes('more'));
});

const scrumDay: Digest['timeLogged'] = [
  ...timeLogged,
  { taskId: 50, taskName: 'AD: Daily scrum, coordination, planning and weekly status calls. *', project: 'AD', stage: null, link: 'https://tw/app/tasks/50', minutes: 36 },
  { taskId: 51, taskName: 'Reusable Automation Services Daily Scrum *', project: 'Services', stage: null, link: 'https://tw/app/tasks/51', minutes: 34 },
];

test('scrum tasks are left out of Worked on — the list, the count and the total', () => {
  const s = buildFactualSummary({ ...base, timeLogged: scrumDay } as unknown as Digest)!;
  assert.ok(!/scrum/i.test(s), 'no scrum task should be read out');
  assert.match(s, /\*Worked on 3 tasks\* · 4h 45m logged/);
});

test('a day of only scrum has no Worked on line', () => {
  const onlyScrum = { ...base, updates: [], timeLogged: scrumDay.slice(3) } as unknown as Digest;
  assert.ok(!(buildFactualSummary(onlyScrum) ?? '').includes('Worked on'));
});

test('the digest still records scrum time — it is left out of stand-up only', () => {
  const s = JSON.stringify(renderDigest({ ...base, timeLogged: scrumDay } as unknown as Digest, 'Asia/Kolkata', undefined, 'week').blocks);
  assert.match(s, /Daily Scrum/);
});

test('with no time logged there is no total, just the task', () => {
  const [head, ...tasks] = workedBlock(buildFactualSummary(withoutTime)!);
  assert.equal(head, '• *Worked on 1 task*');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0]!, /Hibernate modal/);
});

test('Gemini is told about logged time too', () => {
  assert.match(buildPrompt(withTime, false), /Tasks I logged time on:\n- "Restore page state" \(Page Designer\): 3h 0m/);
});

test('the digest shows a Time logged section with the total', () => {
  const s = JSON.stringify(renderDigest(withTime, 'Asia/Kolkata', undefined, 'week').blocks);
  assert.match(s, /⏱️ Time logged · 4h 45m on 3 tasks/);
  assert.match(s, /Restore page state> — 3h/);
});

test('no time logged, no Time logged section', () => {
  assert.ok(!JSON.stringify(renderDigest(withoutTime, 'Asia/Kolkata').blocks).includes('Time logged'));
});

// --- building the digest -------------------------------------------------------------

const config = ConfigSchema.parse({ timezone: 'Asia/Kolkata' });
const recipient = { id: 'alice', label: 'Alice', teamworkUserId: 42, handles: ['AliceA'] };
const ws = () => ({ commentsByTask: new Map(), tasksById: new Map(), usersById: new Map([[42, { id: 42, firstName: 'Alice', lastName: 'A' }]]), activity: [] });
const monday = DateTime.fromISO('2026-09-14T09:00', { zone: 'Asia/Kolkata' });

test('time entries are summed per task, most time first, over the stand-up window', async () => {
  let asked: unknown[] = [];
  const client = {
    siteUrl: 'https://tw',
    person: async () => null,
    timeLoggedBy: async (...args: unknown[]) => {
      asked = args;
      return [
        { taskId: 9, minutes: 20, at: '2026-09-12T05:00:00Z', taskName: 'Sentry', projectName: null },
        { taskId: 7, minutes: 48, at: '2026-09-11T07:21:00Z', taskName: 'Restore state', projectName: 'Page Designer' },
        { taskId: 7, minutes: 53, at: '2026-09-11T08:10:00Z', taskName: 'Restore state', projectName: 'Page Designer' },
      ];
    },
  } as unknown as TeamworkClient;
  const d = await buildDigest(client, ws() as never, config, recipient as never, monday, [], 1, [], [], 3);

  assert.deepEqual(d.timeLogged, [
    { taskId: 7, taskName: 'Restore state', project: 'Page Designer', stage: null, link: 'https://tw/app/tasks/7', minutes: 101 },
    { taskId: 9, taskName: 'Sentry', project: null, stage: null, link: 'https://tw/app/tasks/9', minutes: 20 },
  ]);
  // Friday 00:00 to Sunday 23:59 in Kolkata, asked for as UTC instants.
  assert.equal(asked[0], 42);
  assert.equal(asked[1], '2026-09-10T18:30:00.000Z');
  assert.equal(asked[2], '2026-09-13T18:29:59.999Z');
  assert.ok(d.total >= 2);
});

test('if time logs cannot be read, the rest of the digest still arrives', async () => {
  const client = {
    siteUrl: 'https://tw',
    person: async () => null,
    timeLoggedBy: async () => { throw new Error('Teamwork 503'); },
  } as unknown as TeamworkClient;
  const d = await buildDigest(client, ws() as never, config, recipient as never, monday, [], 1, [], [], 3);
  assert.deepEqual(d.timeLogged, []);
});

// --- reading time from Teamwork -------------------------------------------------------

test('time is asked for with the filter that works, and the window is applied exactly', async () => {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const row = (id: number, userId: number, taskId: number, timeLogged: string, extra: Record<string, unknown> = {}) =>
      ({ id, userId, taskId, projectId: 410089, minutes: 30, timeLogged, deleted: false, ...extra });
    return new Response(JSON.stringify({
      timelogs: [
        row(1, 42, 7, '2026-09-11T07:21:00Z'),
        row(2, 42, 7, '2026-09-10T18:00:00Z'),                 // Thursday 23:30 in Kolkata: before the window
        row(3, 99, 7, '2026-09-11T08:00:00Z'),                 // somebody else's time
        row(4, 42, 0, '2026-09-11T09:00:00Z'),                 // not against a task
        row(5, 42, 8, '2026-09-11T10:00:00Z', { deleted: true }),
        row(6, 42, 9, '2026-09-10T19:47:00Z'),                 // Friday 01:17 in Kolkata, still Thursday in UTC
      ],
      included: { tasks: { 7: { name: 'Restore state' } }, projects: { 410089: { name: 'Page Designer' } } },
      meta: { page: { hasMore: false } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new TeamworkClient({ siteUrl: 'https://tw.example.com', apiToken: 't' });
    const out = await client.timeLoggedBy(42, '2026-09-10T18:30:00.000Z', '2026-09-13T18:29:59.999Z');

    const q = new URL(urls[0]!).searchParams;
    assert.equal(q.get('assignedToUserIds'), '42', 'userId is ignored by this endpoint and returns everyone');
    assert.equal(q.get('startDate'), '2026-09-10');
    assert.equal(q.get('endDate'), '2026-09-13');
    assert.equal(q.get('include'), 'tasks,projects');

    assert.deepEqual(out.map((r) => r.taskId), [7, 9]);
    assert.deepEqual(out[0], { taskId: 7, minutes: 30, at: '2026-09-11T07:21:00Z', taskName: 'Restore state', projectName: 'Page Designer' });
  } finally {
    globalThis.fetch = real;
  }
});
