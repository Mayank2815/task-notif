import { DateTime } from 'luxon';
import type { Config, Recipient } from './config/schema.js';
import { getDismissals } from './config/store.js';
import { activeRules } from './rules/index.js';
import type { RuleContext, RuleMatch } from './rules/types.js';
import { buildIdentity, mentionsIdentity, type Identity } from './teamwork/identity.js';
import { TeamworkClient } from './teamwork/client.js';
import { stageIdsInRange } from './teamwork/stage-range.js';
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
  /** workflowId -> stage ids inside the configured range, or null when unfiltered. */
  inRangeByWorkflow: Map<number, Set<number> | null>;
  /** workflowId -> every stage id the board actually has, for spotting stale ids. */
  knownStageIds: Map<number, Set<number>>;
  /** workflowId -> stageId -> column name. Tasks fetched outside the sweep need this too. */
  stageNames: Map<number, Map<number, string>>;
  commentCount: number;
}

export function makeClient(config: Config, apiToken: string): TeamworkClient {
  return new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken, lookbackDays: config.lookbackDays });
}

export async function collectWorkspace(
  client: TeamworkClient,
  log: (m: string) => void,
  config: Config,
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

  // Resolve board columns once per workflow rather than once per task, and work out
  // which stages fall inside the configured range while we have them.
  const workflowIds = [...new Set([...tasksById.values()].map((t) => t.workflowId).filter((id): id is number => Boolean(id)))];
  const inRangeByWorkflow = new Map<number, Set<number> | null>();
  const knownStageIds = new Map<number, Set<number>>();
  const stageNames = new Map<number, Map<number, string>>();

  for (const workflowId of workflowIds) {
    const stages = await client.workflowStages(workflowId);
    knownStageIds.set(workflowId, new Set(stages.map((s) => s.id)));
    const names = new Map(stages.map((s) => [s.id, s.name]));
    stageNames.set(workflowId, names);
    for (const task of tasksById.values()) {
      if (task.workflowId === workflowId && task.stageId) task.stageName = names.get(task.stageId);
    }
    inRangeByWorkflow.set(workflowId, stageIdsInRange(stages, config.stageRangeStart, config.stageRangeEnd));
  }
  const unanchored = [...inRangeByWorkflow.values()].filter((v) => v === null).length;
  log(`resolved board columns for ${workflowIds.length} workflow(s)${unanchored ? `, ${unanchored} without a recognisable range (left unfiltered)` : ''}`);

  return { commentsByTask, tasksById, usersById, inRangeByWorkflow, knownStageIds, stageNames, commentCount: comments.length };
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
  // tasksAssignedTo returns its own objects, so the sweep's column names are not on
  // them. Without this, every assigned task shows a blank board column.
  for (const t of assigned) {
    if (t.workflowId && t.stageId && !t.stageName) {
      t.stageName = ws.stageNames.get(t.workflowId)?.get(t.stageId);
    }
  }

  const mentionedTaskIds = new Set<number>();
  for (const [taskId, comments] of ws.commentsByTask) {
    if (comments.some((c) => mentionsIdentity(c, identity))) mentionedTaskIds.add(taskId);
  }

  /**
   * A subtask sits on no board column of its own — the parent holds it. Walk up until
   * a column is found, so "FE: <something>" under a parent in Ready for QA counts as
   * being in Ready for QA. Capped, because a cycle would otherwise loop forever.
   */
  const MAX_PARENT_DEPTH = 4;
  const stageOf = async (t: TeamworkTask): Promise<{ workflowId?: number; stageId?: number; inherited: boolean }> => {
    if (t.workflowId && t.stageId) return { workflowId: t.workflowId, stageId: t.stageId, inherited: false };

    let parentId = t.parentTaskId;
    for (let depth = 0; depth < MAX_PARENT_DEPTH && parentId; depth++) {
      const parent = ws.tasksById.get(parentId) ?? (await fetchParent(parentId));
      if (!parent) break;
      if (parent.workflowId && parent.stageId) {
        return { workflowId: parent.workflowId, stageId: parent.stageId, inherited: true };
      }
      parentId = parent.parentTaskId;
    }
    return { inherited: false };
  };

  const parentCache = new Map<number, TeamworkTask | null>();
  async function fetchParent(id: number): Promise<TeamworkTask | null> {
    if (parentCache.has(id)) return parentCache.get(id) ?? null;
    const parent = await client.task(id);
    if (parent?.workflowId && parent.stageId && !parent.stageName) {
      parent.stageName = ws.stageNames.get(parent.workflowId)?.get(parent.stageId);
    }
    parentCache.set(id, parent);
    return parent;
  }

  /**
   * A task is out of scope only when we can positively place its column outside the
   * range. Anything we cannot resolve — no column anywhere up the chain, an unreadable
   * board, or a stage id missing from the board's list — falls back to the config.
   */
  const inScope = async (t: TeamworkTask): Promise<boolean> => {
    const { workflowId, stageId, inherited } = await stageOf(t);
    if (!workflowId || !stageId) return config.includeTasksWithoutStage;

    const allowed = ws.inRangeByWorkflow.get(workflowId) ?? null;
    if (!allowed) return true;
    const known = ws.knownStageIds.get(workflowId);
    if (known && !known.has(stageId)) return true; // stale or unlisted column
    if (inherited && !t.stageName) {
      t.stageName = ws.stageNames.get(workflowId)?.get(stageId); // show the parent's column
    }
    return allowed.has(stageId);
  };

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
  /**
   * A task marked done stays hidden until someone says something new on it.
   * The dismissal records when it was pressed, so any comment after that moment
   * revives the task — pressing Done again re-hides it from that point on.
   */
  const dismissedAt = new Map(getDismissals(recipient.id).map((d) => [d.key, d.at]));
  let dismissedCount = 0;
  let revivedCount = 0;

  for (const [id] of [...candidates]) {
    const at = dismissedAt.get(`task:${id}`);
    if (!at) continue;

    const latestComment = (ws.commentsByTask.get(id) ?? [])
      .map((c) => c.postedAt ?? '')
      .reduce((a, b) => (a > b ? a : b), '');

    if (latestComment && latestComment > at) { revivedCount++; continue; }
    candidates.delete(id);
    dismissedCount++;
  }

  const beforeRange = candidates.size;
  for (const [id, task] of [...candidates]) {
    if (!(await inScope(task))) candidates.delete(id);
  }
  const dropped = beforeRange - candidates.size;
  log(
    `${identity.displayName}: ${assigned.length} assigned, ${mentionedTaskIds.size} mentioning, ` +
    `${candidates.size} candidates${dropped ? ` (${dropped} outside the board range)` : ''}` +
    `${dismissedCount ? ` (${dismissedCount} marked done)` : ''}` +
    `${revivedCount ? ` (${revivedCount} revived by a new comment)` : ''}`,
  );

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
  const ws = await collectWorkspace(client, log, config);

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
