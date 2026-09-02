import { z } from 'zod';

export const RecipientSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  teamworkUserId: z.number().int().positive(),
  /** Teamwork @-handles that mean this person. Mentions carry no user id, so the handle is the key. */
  handles: z.array(z.string()).min(1),
  /** Slack user ID (U…) for a DM, or a channel ID. Resolved from slackEmail when blank. */
  slackTarget: z.string().default(''),
  slackEmail: z.string().email().or(z.literal('')).default(''),
  /**
   * This person's Slack user token (xoxp-) for mention search. Optional.
   * SLACK_USER_TOKEN_<ID> in the environment takes precedence when both are set,
   * so an operator can keep secrets out of the store file if they prefer.
   */
  slackUserToken: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Send this person a copy of another recipient's list instead of their own. */
  mirrorOf: z.string().nullable().default(null),
});

export type Recipient = z.infer<typeof RecipientSchema>;

/** One scheduled send. The morning reminder and the end-of-day digest are both jobs. */
export const JobSchema = z.object({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Luxon weekday numbers: 1 = Monday .. 7 = Sunday. */
  daysOfWeek: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  enabled: z.boolean().default(true),
});

export type Job = z.infer<typeof JobSchema>;
export type JobKind = 'reminder' | 'digest';

export const ConfigSchema = z.object({
  teamworkSiteUrl: z.string().url().default('https://projects.example.com'),
  recipients: z.array(RecipientSchema).default([]),

  jobs: z.object({
    /** Morning: what needs your attention. */
    reminder: JobSchema.default({ time: '09:00' }),
    /** Evening: what you actually did, for tomorrow's standup. */
    digest: JobSchema.default({ time: '21:00' }),
  }).default({}),

  /**
   * How late a missed slot may still be delivered after the machine comes back.
   * Generous by design: a laptop that was asleep at 09:00 should still get the
   * reminder when it opens, marked as late, rather than nothing at all.
   */
  catchUpGraceMinutes: z.number().int().min(5).max(1440).default(300),

  timezone: z.string().default('Asia/Kolkata'),

  sendWhenEmpty: z.boolean().default(false),
  enabled: z.boolean().default(true),

  lookbackDays: z.number().int().min(1).max(365).default(60),
  /** Rule C: treat tasks due today as needing attention, not just strictly past-due. */
  includeDueToday: z.boolean().default(true),
  /** Skip comments that only name you inside a "cc"/"fyi" list — nothing is being asked of you. */
  ignoreCcOnlyMentions: z.boolean().default(true),
  /** Include Slack mentions in the digest and reminder. Needs a per-person xoxp- token. */
  slackMentionsEnabled: z.boolean().default(true),
  /** Drop Slack messages tagging more than this many people (bot broadcasts). 0 disables the filter. */
  slackBroadcastThreshold: z.number().int().min(0).max(50).default(5),
  /**
   * Have Gemini write the stand-up summary. When off, or when the call fails, the
   * summary is assembled from the same facts locally instead.
   */
  standupSummaryEnabled: z.boolean().default(false),
  /**
   * Send DM text to Gemini as well. Off by default — channel messages are already
   * semi-public, a DM is not, and the summary rarely needs its contents.
   */
  standupSummaryIncludeDmText: z.boolean().default(false),
  /** How far back the morning reminder looks for still-unanswered Slack mentions. */
  slackPendingDays: z.number().int().min(1).max(30).default(3),
  /** Slack cc-only mentions are kept by default — a Slack cc often still matters. */
  slackIgnoreCcOnly: z.boolean().default(false),
  /**
   * Hide a thread once someone else who was tagged has replied. Off by default:
   * "@A @B please check this" and "@A @B can you raise the PR" are structurally
   * identical, yet one is discharged by a colleague and the other is not. Without
   * reading intent there is no safe way to tell them apart, so the row is flagged
   * and ranked lower instead of being dropped.
   */
  slackHideWhenCoMentionedReplied: z.boolean().default(false),
  disabledRules: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export const RunRecordSchema = z.object({
  at: z.string(),
  job: z.enum(['reminder', 'digest']).default('reminder'),
  trigger: z.enum(['scheduled', 'manual']),
  ok: z.boolean(),
  detail: z.string(),
  perRecipient: z.array(z.object({ id: z.string(), matched: z.number(), delivered: z.boolean(), error: z.string().nullable() })).default([]),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

/** A Slack thread a recipient has dismissed from their reminders. */
export const DismissalSchema = z.object({
  recipientId: z.string(),
  /** channelId:threadTs — stable across reruns. */
  key: z.string(),
  at: z.string(),
  label: z.string().default(''),
});

export type Dismissal = z.infer<typeof DismissalSchema>;

export const StoreSchema = z.object({
  config: ConfigSchema.default({}),
  dismissals: z.array(DismissalSchema).default([]),
  /** Newest first; trimmed so the file cannot grow without bound. */
  runs: z.array(RunRecordSchema).default([]),
});

export type StoreData = z.infer<typeof StoreSchema>;
