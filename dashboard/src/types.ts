export interface Recipient {
  id: string;
  label: string;
  teamworkUserId: number;
  handles: string[];
  slackTarget: string;
  slackEmail: string;
  enabled: boolean;
  mirrorOf: string | null;
  /** Write-only: the API reports whether a token is set, never its value. */
  slackUserToken?: string;
  hasSlackUserToken?: boolean;
  slackUserTokenSource?: 'environment' | 'dashboard' | null;
}

export interface HandleCandidate {
  handle: string;
  confidence: 'confirmed' | 'seen' | 'guessed';
  count: number;
}

export interface PersonSuggestion {
  id: number;
  name: string;
  email: string;
  candidates: HandleCandidate[];
}


export interface Job {
  time: string;
  daysOfWeek: number[];
  enabled: boolean;
}

export type JobKind = 'reminder' | 'digest';

export interface Config {
  teamworkSiteUrl: string;
  recipients: Recipient[];
  jobs: Record<JobKind, Job>;
  timezone: string;
  sendWhenEmpty: boolean;
  enabled: boolean;
  lookbackDays: number;
  includeDueToday: boolean;
  ignoreCcOnlyMentions: boolean;
  slackMentionsEnabled: boolean;
  slackIgnoreCcOnly: boolean;
  slackHideWhenCoMentionedReplied: boolean;
  slackBroadcastThreshold: number;
  slackPendingDays: number;
  standupSummaryEnabled: boolean;
  standupSummaryIncludeDmText: boolean;
  catchUpGraceMinutes: number;
  disabledRules: string[];
}

export interface RunRecord {
  at: string;
  job: JobKind;
  trigger: 'scheduled' | 'manual';
  ok: boolean;
  detail: string;
}

export interface Status {
  teamwork: { ok: boolean; detail: string };
  slack: { ok: boolean; detail: string; targets: { id: string; resolved: string | null; source: string }[] };
  nextRun: string | null;
  nextRuns: Record<JobKind, string | null>;
  runs: RunRecord[];
}

export interface PreviewItem {
  id: number;
  name: string;
  project: string | null;
  assignees: string[];
  dueDate: string | null;
  detail: string;
  link: string;
}

export interface Preview {
  stats: { commentsSwept: number; tasksIndexed: number; durationMs: number };
  results: {
    recipientId: string;
    label: string;
    total: number;
    groups: { ruleId: string; label: string; items: PreviewItem[] }[];
  }[];
}

export interface RuleInfo { id: string; label: string; priority: number; enabled: boolean }
