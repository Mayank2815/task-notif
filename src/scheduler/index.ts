import { DateTime } from 'luxon';
import type { Config, Job, JobKind } from '../config/schema.js';
import { getConfig, getRuns } from '../config/store.js';
import { runAndDeliver } from '../deliver.js';

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout overflows past ~24.8 days and would fire immediately

/**
 * A laptop waking at 09:00 often has no network for the first minute or two, and a
 * failed run used to be skipped until the next day. These delays cover roughly the
 * first hour, which is where transient failures cluster.
 */
const RETRY_DELAYS_MS = [60_000, 180_000, 600_000, 1_800_000];

export const JOB_KINDS: JobKind[] = ['reminder', 'digest'];

export interface SchedulerDeps {
  teamworkToken: string;
  slackToken: string;
  log?: (m: string) => void;
}

/** Next enabled weekday at the job's local time, strictly after `from`. */
export function nextFireTime(config: Config, job: Job, from: DateTime = DateTime.now()): DateTime | null {
  if (!config.enabled || !job.enabled || job.daysOfWeek.length === 0) return null;

  const [hourStr, minuteStr] = job.time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const origin = from.setZone(config.timezone);

  for (let i = 0; i <= 14; i++) {
    const candidate = origin.plus({ days: i }).set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= origin) continue;
    if (job.daysOfWeek.includes(candidate.weekday)) return candidate;
  }
  return null;
}

/**
 * True when the job's slot has passed, is still within grace, and nothing was
 * successfully sent for it yet. `lastSuccessfulRunAt` must be a successful run —
 * passing a failed one here would silently cancel the catch-up.
 */
export function shouldCatchUp(config: Config, job: Job, now: DateTime, lastSuccessfulRunAt: string | null): boolean {
  if (!config.enabled || !job.enabled) return false;

  const local = now.setZone(config.timezone);
  if (!job.daysOfWeek.includes(local.weekday)) return false;

  const [hourStr, minuteStr] = job.time.split(':');
  const slot = local.set({ hour: Number(hourStr), minute: Number(minuteStr), second: 0, millisecond: 0 });
  if (local < slot) return false;
  if (local > slot.plus({ minutes: config.catchUpGraceMinutes })) return false;

  if (!lastSuccessfulRunAt) return true;
  return DateTime.fromISO(lastSuccessfulRunAt).setZone(config.timezone) < slot;
}

export class Scheduler {
  private readonly timers = new Map<JobKind, NodeJS.Timeout>();
  private readonly retryTimers = new Map<JobKind, NodeJS.Timeout>();
  private readonly running = new Set<JobKind>();
  private readonly log: (m: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.log ?? ((m) => console.log(`[scheduler] ${m}`));
  }

  start(): void {
    const config = getConfig();
    for (const kind of JOB_KINDS) {
      // Any SUCCESSFUL send satisfies the slot, however it was triggered. Sending the
      // missed reminder by hand and then restarting must not deliver it a second time.
      // Failures are excluded: that slot is still owed.
      const last = getRuns().find((r) => r.job === kind && r.ok)?.at ?? null;
      // A restart during a slot must not silently skip it.
      if (process.env.SUPPRESS_CATCHUP === '1') {
        this.log(`${kind}: catch-up suppressed by SUPPRESS_CATCHUP`);
        continue;
      }
      if (shouldCatchUp(config, config.jobs[kind], DateTime.now(), last)) {
        const slot = config.jobs[kind].time;
        this.log(`missed today's ${kind} slot (${slot}) while the machine was off — sending it now`);
        void this.fire(kind, `⏰ Late — your machine was off at ${slot}`);
      }
    }
    this.scheduleAll();
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.retryTimers.clear();
  }

  /** Call after any config change so the next fire times reflect it immediately. */
  reschedule(): void {
    this.stop();
    this.scheduleAll();
  }

  get nextRuns(): Record<JobKind, string | null> {
    const config = getConfig();
    return {
      reminder: nextFireTime(config, config.jobs.reminder)?.toISO() ?? null,
      digest: nextFireTime(config, config.jobs.digest)?.toISO() ?? null,
    };
  }

  /** Kept for the dashboard header: whichever job fires next. */
  get nextRun(): string | null {
    const times = Object.values(this.nextRuns).filter((t): t is string => t !== null).sort();
    return times[0] ?? null;
  }

  private scheduleAll(): void {
    for (const kind of JOB_KINDS) this.schedule(kind);
  }

  private schedule(kind: JobKind): void {
    const config = getConfig();
    const next = nextFireTime(config, config.jobs[kind]);
    if (!next) {
      this.log(`${kind}: disabled — no next run`);
      return;
    }

    const delay = Math.max(0, Math.min(next.diffNow().toMillis(), MAX_TIMEOUT_MS));
    this.log(`${kind}: next run ${next.toFormat('ccc d LLL HH:mm ZZZZ')} (in ${(delay / 60000).toFixed(1)} min)`);

    this.timers.set(
      kind,
      setTimeout(() => {
        // A clamped timer has not reached the target yet; re-arm rather than fire early.
        if (DateTime.now() < next.minus({ seconds: 30 })) {
          this.schedule(kind);
          return;
        }
        void this.fire(kind).finally(() => this.schedule(kind));
      }, delay),
    );
  }

  /**
   * Runs the job, retrying transient failures rather than losing the day.
   * `attempt` is 0 for the scheduled run and increments per retry.
   */
  async fire(kind: JobKind, note?: string, attempt = 0): Promise<void> {
    if (this.running.has(kind)) {
      this.log(`${kind}: previous run still in flight — skipping this tick`);
      return;
    }
    this.running.add(kind);
    try {
      await runAndDeliver(getConfig(), this.deps.teamworkToken, this.deps.slackToken, kind, 'scheduled', this.log, note);
      if (attempt > 0) this.log(`${kind}: succeeded on retry ${attempt}`);
    } catch (err) {
      const message = (err as Error).message;
      const delay = RETRY_DELAYS_MS[attempt];

      if (delay === undefined) {
        this.log(`${kind}: failed after ${RETRY_DELAYS_MS.length} retries (${message}) — giving up until the next slot`);
        return;
      }

      this.log(`${kind}: run failed (${message}) — retry ${attempt + 1} in ${Math.round(delay / 60_000)} min`);
      const timer = setTimeout(() => void this.fire(kind, note ?? '⏰ Late — the first attempt could not reach the network', attempt + 1), delay);
      this.retryTimers.set(kind, timer);
    } finally {
      this.running.delete(kind);
    }
  }
}
