import { DateTime } from 'luxon';
import type { Config } from './config/schema.js';
import { buildDigest } from './digest.js';
import { workspacesByToken, type TokenContext } from './pipeline.js';
import type { TeamworkActivity } from './teamwork/types.js';

/** A day of slack, so a report that ends today still sweeps far enough back. */
const LOOKBACK_PADDING_DAYS = 2;

export interface ReportPerson {
  recipientId: string;
  label: string;
  /** Tasks closed inside the window. */
  completed: { taskId: number; taskName: string; project: string | null; link: string; at: string }[];
  /** Distinct tasks they commented on or logged time on, most time first. */
  workedOn: { taskId: number; taskName: string; project: string | null; link: string; minutes: number }[];
  /** All time logged in the window — for an appraisal, the plainest measure of effort. */
  totalMinutes: number;
  /** Every comment counted, which is the effort behind workedOn. */
  comments: number;
  /** Moves, edits and completions recorded against them in the activity feed. */
  statusChanges: number;
  newlyAssigned: { taskId: number; taskName: string; project: string | null; link: string }[];
}

export interface RangeReport {
  from: string;
  to: string;
  days: number;
  people: ReportPerson[];
  /**
   * Teamwork only. Slack search is per-person and its history depends on the
   * workspace's retention, so a report months back would be quietly incomplete.
   */
  source: 'teamwork';
  stats: { commentsSwept: number; activityEntries: number; durationMs: number };
}

/** Turns a from/to pair into the offset-and-span the digest window speaks. */
export function windowFor(
  from: string, to: string, timezone: string, now: DateTime = DateTime.now(),
): { dayOffset: number; spanDays: number } {
  const today = now.setZone(timezone).startOf('day');
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timezone }).startOf('day');

  if (!start.isValid || !end.isValid) throw new Error('dates must look like 2026-08-01');
  if (end < start) throw new Error('the end date cannot be before the start date');
  if (end > today) throw new Error('the end date cannot be in the future');

  return {
    dayOffset: Math.round(today.diff(end, 'days').days),
    spanDays: Math.round(end.diff(start, 'days').days) + 1,
  };
}

/**
 * What each person did between two dates.
 *
 * Nothing is read from a store: no item-level history is kept anywhere, only the last
 * fifty run records and their counts. Teamwork is the system of record and holds the
 * detail, so the report asks it directly — which is why this works for a month that has
 * already passed, rather than only for months after the feature shipped.
 *
 * It is slow by nature. A month is a few thousand comments to sweep; half a year is tens
 * of thousands. Run it in the background and show progress, never on a schedule.
 */
export async function buildRangeReport(
  config: Config,
  teamworkToken: string,
  from: string,
  to: string,
  log: (m: string) => void = () => {},
  now: DateTime = DateTime.now(),
): Promise<RangeReport> {
  const started = Date.now();
  const { dayOffset, spanDays } = windowFor(from, to, config.timezone, now);

  // The client's own cutoff bounds every sweep, so it has to reach past the window's
  // first day rather than use the thirty days the daily run is tuned for.
  const lookbackDays = dayOffset + spanDays + LOOKBACK_PADDING_DAYS;
  log(`reading ${spanDays} day(s) up to ${to} — sweeping ${lookbackDays} days of Teamwork`);
  const recipients = config.recipients.filter((r) => r.enabled);
  // Each person through their own token where they have given one: a board the shared
  // token cannot see would otherwise report its whole team as having done nothing.
  const contexts = await workspacesByToken(config, teamworkToken, recipients, log, lookbackDays);

  const since = DateTime.fromISO(from, { zone: config.timezone }).startOf('day').toUTC().toISO() ?? '';
  const activityBy = new Map<TokenContext, TeamworkActivity[]>();
  for (const context of new Set(contexts.values())) activityBy.set(context, await context.client.activitySince(since));
  log(`fetched ${[...activityBy.values()].reduce((n, a) => n + a.length, 0)} activity entries`);

  const people: ReportPerson[] = [];
  for (const recipient of recipients) {
    const context = contexts.get(recipient.id)!;
    // No Slack: a report over past months cannot honestly include it.
    const digest = await buildDigest(
      context.client, { ...context.workspace, activity: activityBy.get(context)! }, config, recipient, now, [], dayOffset, [], [], spanDays,
    );

    const byTask = new Map<number, ReportPerson['workedOn'][number]>();
    for (const u of digest.updates) {
      byTask.set(u.taskId, { taskId: u.taskId, taskName: u.taskName, project: u.project, link: u.taskLink, minutes: 0 });
    }
    // Logged time is work in its own right: an afternoon of code often leaves no comment,
    // and an appraisal that counted only comments would miss it the same way the stand-up did.
    for (const t of digest.timeLogged) {
      const seen = byTask.get(t.taskId);
      if (seen) seen.minutes = t.minutes;
      else byTask.set(t.taskId, { taskId: t.taskId, taskName: t.taskName, project: t.project, link: t.link, minutes: t.minutes });
    }
    const totalMinutes = digest.timeLogged.reduce((n, t) => n + t.minutes, 0);

    people.push({
      recipientId: recipient.id,
      label: recipient.label,
      completed: digest.completed.map((c) => ({
        taskId: c.taskId, taskName: c.taskName, project: c.project, link: c.link, at: c.at,
      })),
      workedOn: [...byTask.values()].sort((a, b) => b.minutes - a.minutes),
      totalMinutes,
      comments: digest.updates.length,
      statusChanges: digest.statusChanges.length,
      newlyAssigned: digest.newlyAssigned.map((t) => ({
        taskId: t.taskId, taskName: t.taskName, project: t.project, link: t.link,
      })),
    });
    log(`${recipient.label}: ${digest.completed.length} closed, ${byTask.size} tasks touched, ${Math.round(totalMinutes / 60)}h logged`);
  }

  return {
    from, to, days: spanDays, people, source: 'teamwork',
    stats: {
      commentsSwept: [...activityBy.keys()].reduce((n, c) => n + c.workspace.commentCount, 0),
      activityEntries: [...activityBy.values()].reduce((n, a) => n + a.length, 0),
      durationMs: Date.now() - started,
    },
  };
}
