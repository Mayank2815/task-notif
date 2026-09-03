import { DateTime } from 'luxon';
import type { Config, Recipient } from './config/schema.js';
import { mentionRole, snippet, toPlainText } from './teamwork/identity.js';
import { buildIdentity, type Identity } from './teamwork/identity.js';
import type { TeamworkClient } from './teamwork/client.js';
import type { TeamworkActivity, TeamworkComment, TeamworkTask, TeamworkUser } from './teamwork/types.js';
import type { ChannelActivity, MeetingMention, SlackMention } from './slack/mentions.js';

/** Links that count as "here is the code" in a comment. */
const PR_PATTERNS = [
  /https?:\/\/github\.com\/[^\s)>\]]+\/pull\/\d+/gi,
  /https?:\/\/gitlab\.[^\s)>\]]+\/-\/merge_requests\/\d+/gi,
  /https?:\/\/bitbucket\.org\/[^\s)>\]]+\/pull-requests\/\d+/gi,
  /https?:\/\/[^\s)>\]]*console\.aws\.amazon\.com\/codesuite\/[^\s)>\]]+/gi,
  /https?:\/\/dev\.azure\.com\/[^\s)>\]]+\/pullrequest\/\d+/gi,
];

/** Phrases that mark a comment as a completion note rather than discussion. */
const DONE_MARKERS = ['dev done', 'devdone', 'dev complete', 'dev completion', 'code review', 'ready for qa', 'ready to qa', 'deployed', 'merged', 'pr raised', 'prs are raised', 'raised the pr', 'backmerge'];
const BLOCKER_MARKERS = ['blocked', 'blocker', 'waiting on', 'waiting for', 'cannot proceed', "can't proceed", 'need access', 'dependency on', 'on hold'];

export interface DigestEntry {
  taskId: number;
  taskName: string;
  project: string | null;
  /** Board column, e.g. "Ready for QA". */
  stage: string | null;
  link: string;
  /** Link to the task itself, not the triggering comment. */
  taskLink: string;
  at: string;
  text: string;
  prLinks: string[];
  isDone: boolean;
  isBlocker: boolean;
}

export interface DigestMention {
  taskId: number;
  taskName: string;
  project: string | null;
  stage: string | null;
  link: string;
  at: string;
  author: string;
  text: string;
  answered: boolean;
}

export interface Digest {
  recipient: Recipient;
  identity: Identity;
  dayLabel: string;
  updates: DigestEntry[];
  mentionsAnswered: DigestMention[];
  mentionsOpen: DigestMention[];
  completed: { taskId: number; taskName: string; project: string | null; stage: string | null; link: string; at: string }[];
  statusChanges: { description: string; at: string; link: string | null }[];
  newlyAssigned: { taskId: number; taskName: string; project: string | null; stage: string | null; link: string }[];
  slackReplied: SlackMention[];
  slackAwaiting: SlackMention[];
  /** Conversations you actually spoke in, busiest first. */
  slackActivity: ChannelActivity[];
  /** Calls set up or held, from Slack. */
  meetings: MeetingMention[];
  /** 0 = today so far, 1 = the whole of yesterday. */
  dayOffset: number;
  /** Gemini's stand-up write-up. Null when disabled or the call failed. */
  summary: string | null;
  total: number;
}

export interface DigestWorkspace {
  commentsByTask: Map<number, TeamworkComment[]>;
  tasksById: Map<number, TeamworkTask>;
  usersById: Map<number, TeamworkUser>;
  activity: TeamworkActivity[];
}

/**
 * The window a digest covers, in the configured timezone.
 * `dayOffset` 0 is today so far; 1 is the whole of yesterday, which is what a
 * morning stand-up actually reports on.
 */
export function digestWindow(
  config: Config,
  now: DateTime = DateTime.now(),
  dayOffset = 0,
): { start: DateTime; end: DateTime; label: string } {
  const local = now.setZone(config.timezone);
  if (dayOffset === 0) {
    return { start: local.startOf('day'), end: local, label: local.toFormat('cccc, d LLLL') };
  }
  const day = local.minus({ days: dayOffset }).startOf('day');
  return { start: day, end: day.endOf('day'), label: day.toFormat('cccc, d LLLL') };
}

export function extractPrLinks(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PR_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) found.add(m[0]);
  }
  return [...found];
}

function hasMarker(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

export async function buildDigest(
  client: TeamworkClient,
  ws: DigestWorkspace,
  config: Config,
  recipient: Recipient,
  now: DateTime = DateTime.now(),
  slackMentions: SlackMention[] = [],
  dayOffset = 0,
  slackActivity: ChannelActivity[] = [],
  meetings: MeetingMention[] = [],
): Promise<Digest> {
  const user = ws.usersById.get(recipient.teamworkUserId) ??
    (await client.person(recipient.teamworkUserId)) ?? { id: recipient.teamworkUserId };
  const identity = buildIdentity(user, recipient.handles);
  const { start, end, label } = digestWindow(config, now, dayOffset);
  const startIso = start.toUTC().toISO() ?? '';
  const endIso = end.toUTC().toISO() ?? '';
  const inWindow = (iso: string | null | undefined): boolean =>
    Boolean(iso) && iso! >= startIso && iso! <= endIso;

  const updates: DigestEntry[] = [];
  const mentionsAnswered: DigestMention[] = [];
  const mentionsOpen: DigestMention[] = [];

  for (const [taskId, comments] of ws.commentsByTask) {
    const task = ws.tasksById.get(taskId);
    const today = comments.filter((c) => inWindow(c.postedAt));
    if (today.length === 0) continue;

    for (const c of today) {
      const text = toPlainText(`${c.htmlBody || c.body}`);

      if (c.authorId === identity.userId) {
        updates.push({
          taskId,
          taskName: task?.name ?? `Task ${taskId}`,
          project: task?.projectName ?? null,
          stage: task?.stageName ?? null,
          link: c.url,
          taskLink: task?.url ?? c.url,
          at: c.postedAt ?? '',
          text: snippet(text, 240),
          prLinks: extractPrLinks(`${c.body} ${c.htmlBody}`),
          isDone: hasMarker(text, DONE_MARKERS),
          isBlocker: hasMarker(text, BLOCKER_MARKERS),
        });
        continue;
      }

      // Someone else's comment: does it address me, and did I answer it since?
      const role = mentionRole(c, identity);
      if (role === 'none') continue;
      if (role === 'cc' && config.ignoreCcOnlyMentions) continue;

      const answered = comments.some(
        (later) => later.authorId === identity.userId && (later.postedAt ?? '') > (c.postedAt ?? ''),
      );
      const entry: DigestMention = {
        taskId,
        taskName: task?.name ?? `Task ${taskId}`,
        project: task?.projectName ?? null,
        stage: task?.stageName ?? null,
        link: c.url,
        at: c.postedAt ?? '',
        author: nameOf(ws.usersById, c.authorId),
        text: snippet(text, 200),
        answered,
      };
      (answered ? mentionsAnswered : mentionsOpen).push(entry);
    }
  }

  // Activity the person performed today. Comment activity is dropped — the updates
  // section above already covers it, keyed on item.type rather than the id (a comment
  // activity's itemId is the comment's, not the task's).
  const mine = ws.activity.filter((a) => a.userId === identity.userId && inWindow(a.dateTime) && a.itemType !== 'comments');

  const taskLink = (id: number | undefined) => (id ? `${client.siteUrl}/app/tasks/${id}` : null);

  const completed = mine
    .filter((a) => a.activityType === 'completed' && a.itemType === 'tasks')
    .map((a) => ({
      taskId: a.itemId ?? 0,
      taskName: (a.itemId ? ws.tasksById.get(a.itemId)?.name : undefined) ?? snippet(toPlainText(a.description), 90),
      project: (a.itemId ? ws.tasksById.get(a.itemId)?.projectName : undefined) ?? null,
      stage: (a.itemId ? ws.tasksById.get(a.itemId)?.stageName : undefined) ?? null,
      link: taskLink(a.itemId) ?? '',
      at: a.dateTime,
    }));

  const completedIds = new Set(completed.map((c) => c.taskId));
  const statusChanges = mine
    .filter((a) => a.activityType !== 'completed')
    .filter((a) => !(a.itemId && completedIds.has(a.itemId)))
    .map((a) => ({
      description: `${a.activityType} — ${snippet(toPlainText(a.description), 120)}`,
      at: a.dateTime,
      link: a.itemType === 'tasks' ? taskLink(a.itemId) : null,
    }));

  // Work that landed on them today — the ad-hoc/priority items standup asks about.
  const newlyAssigned = [...ws.tasksById.values()]
    .filter((t) => t.assigneeIds.includes(identity.userId))
    .filter((t) => inWindow(t.createdAt))
    .map((t) => ({ taskId: t.id, taskName: t.name, project: t.projectName ?? null, stage: t.stageName ?? null, link: t.url }));

  const byTime = <T extends { at: string }>(a: T, b: T) => a.at.localeCompare(b.at);
  updates.sort(byTime);
  mentionsAnswered.sort(byTime);
  mentionsOpen.sort(byTime);
  statusChanges.sort(byTime);
  completed.sort(byTime);

  return {
    recipient,
    identity,
    dayLabel: label,
    updates,
    mentionsAnswered,
    mentionsOpen,
    completed,
    statusChanges,
    newlyAssigned,
    slackReplied: slackMentions.filter((m) => m.answered),
    slackAwaiting: slackMentions.filter((m) => !m.answered),
    slackActivity,
    meetings,
    dayOffset,
    summary: null,
    total:
      updates.length + mentionsAnswered.length + mentionsOpen.length +
      completed.length + statusChanges.length + newlyAssigned.length + slackMentions.length +
      slackActivity.length + meetings.length,
  };
}

function nameOf(users: Map<number, TeamworkUser>, id: number | null): string {
  if (!id) return 'Someone';
  const u = users.get(id);
  if (!u) return `user ${id}`;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `user ${id}`;
}
