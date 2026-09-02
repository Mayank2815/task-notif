import { DateTime } from 'luxon';
import type { Config, Recipient } from './config/schema.js';
import { activeRules } from './rules/index.js';
import type { RuleContext, RuleMatch } from './rules/types.js';
import { buildIdentity, mentionsIdentity, type Identity } from './teamwork/identity.js';
import { TeamworkClient } from './teamwork/client.js';
import type { TeamworkComment, TeamworkTask, TeamworkUser } from './teamwork/types.js';

export interface MatchedTask {
  task: TeamworkTask;
  match: RuleMatch;
  ruleLabel: string;
  assigneeNames: string[];
}

export interface RecipientResult {
  recipient: Recipient;
  identity: Identity;
  groups: { ruleId: string; label: string; items: MatchedTask[] }[];
  total: number;
}

export interface ScanResult {
  results: RecipientResult[];
  stats: {
    commentsSwept: number;
    tasksIndexed: number;
    durationMs: number;
  };
}

/** Comments, tasks and people fetched once and shared by every recipient's evaluation. */
export interface Workspace {
  commentsByTask: Map<number, TeamworkComment[]>;
  tasksById: Map<number, TeamworkTask>;
  usersById: Map<number, TeamworkUser>;
  commentCount: number;
}

export function makeClient(config: Config, apiToken: string): TeamworkClient {
  return new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken, lookbackDays: config.lookbackDays });
}

export async function collectWorkspace(
  client: TeamworkClient,
  log: (m: string) => void,
): Promise<Workspace> {
  const comments = await client.recentTaskComments((n) => {
    if (n % 2500 === 0) log(`  …swept ${n} comments`);
  });
  log(`swept ${comments.length} task comments`);

  const commentsByTask = new Map<number, TeamworkComment[]>();
  for (const c of comments) {
    const list = commentsByTask.get(c.taskId);
    if (list) list.push(c);
    else commentsByTask.set(c.taskId, [c]);
  }
  // The sweep arrives newest-first; rules read threads oldest-first.
  for (const list of commentsByTask.values()) {
    list.sort((a, b) => (a.postedAt ?? '').localeCompare(b.postedAt ?? ''));
  }

  const recent = await client.recentTasks();
  const tasksById = new Map(recent.map((t) => [t.id, t]));
  log(`indexed ${tasksById.size} recently-updated tasks`);

  const people = await client.people();
  const usersById = new Map(people.map((p) => [p.id, p]));

  // Resolve board columns once per workflow rather than once per task.
  const workflowIds = [...new Set([...tasksById.values()].map((t) => t.workflowId).filter((id): id is number => Boolean(id)))];
  for (const workflowId of workflowIds) {
    const stages = await client.workflowStages(workflowId);
    for (const task of tasksById.values()) {
      if (task.workflowId === workflowId && task.stageId) task.stageName = stages.get(task.stageId);
    }
  }
  log(`resolved board columns for ${workflowIds.length} workflow(s)`);

  return { commentsByTask, tasksById, usersById, commentCount: comments.length };
}

async function evaluateRecipient(
  client: TeamworkClient,
  ws: Workspace,
  config: Config,
  recipient: Recipient,
  log: (m: string) => void,
): Promise<RecipientResult> {
  const user = ws.usersById.get(recipient.teamworkUserId) ??
    (await client.person(recipient.teamworkUserId)) ?? { id: recipient.teamworkUserId };
  const identity = buildIdentity(user, recipient.handles);

  const assigned = await client.tasksAssignedTo(identity.userId);

  const mentionedTaskIds = new Set<number>();
  for (const [taskId, comments] of ws.commentsByTask) {
    if (comments.some((c) => mentionsIdentity(c, identity))) mentionedTaskIds.add(taskId);
  }

  // Hard exclude: a task this person appears on nowhere can never match.
  // Assignment or a mention is the entry ticket; follower-only tasks trip no rule.
  const candidates = new Map<number, TeamworkTask>();
  for (const t of assigned) candidates.set(t.id, t);
  for (const id of mentionedTaskIds) {
    if (candidates.has(id)) continue;
    const known = ws.tasksById.get(id);
    if (known) {
      if (!known.completed) candidates.set(id, known);
    } else {
      const fetched = await client.task(id);
      if (fetched && !fetched.completed) candidates.set(id, fetched);
    }
  }
  log(`${identity.displayName}: ${assigned.length} assigned, ${mentionedTaskIds.size} mentioning, ${candidates.size} candidates`);

  const now = DateTime.now();
  const rules = activeRules(config.disabledRules);
  const matched: MatchedTask[] = [];

  for (const task of candidates.values()) {
    const ctx: RuleContext = { identity, config, now, comments: ws.commentsByTask.get(task.id) ?? [], usersById: ws.usersById };
    // Rules are ordered by priority, so the first hit is the one we report.
    for (const rule of rules) {
      const match = rule.evaluate(task, ctx);
      if (match) {
        matched.push({
          task,
          match,
          ruleLabel: rule.label,
          assigneeNames: task.assigneeIds.map((id) => nameOf(ws.usersById, id)),
        });
        break;
      }
    }
  }

  const groups = rules
    .map((r) => ({ ruleId: r.id, label: r.label, items: matched.filter((m) => m.match.ruleId === r.id).sort(byDueThenName) }))
    .filter((g) => g.items.length > 0);

  return { recipient, identity, groups, total: matched.length };
}

export async function runScan(config: Config, apiToken: string, log: (m: string) => void = () => {}): Promise<ScanResult> {
  const started = Date.now();
  const client = makeClient(config, apiToken);
  const ws = await collectWorkspace(client, log);

  const active = config.recipients.filter((r) => r.enabled);
  const results: RecipientResult[] = [];

  // Own-list recipients first, so mirrors can copy a result that already exists.
  for (const recipient of active.filter((r) => !r.mirrorOf)) {
    results.push(await evaluateRecipient(client, ws, config, recipient, log));
  }
  for (const recipient of active.filter((r) => r.mirrorOf)) {
    const source = results.find((r) => r.recipient.id === recipient.mirrorOf);
    if (!source) {
      log(`${recipient.label}: mirrorOf "${recipient.mirrorOf}" not found — skipped`);
      continue;
    }
    results.push({ ...source, recipient });
  }

  return {
    results,
    stats: { commentsSwept: ws.commentCount, tasksIndexed: ws.tasksById.size, durationMs: Date.now() - started },
  };
}

function nameOf(users: Map<number, TeamworkUser>, id: number): string {
  const u = users.get(id);
  if (!u) return `user ${id}`;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `user ${id}`;
}

function byDueThenName(a: MatchedTask, b: MatchedTask): number {
  const ad = a.task.dueDate ?? '9999';
  const bd = b.task.dueDate ?? '9999';
  return ad === bd ? a.task.name.localeCompare(b.task.name) : ad.localeCompare(bd);
}
