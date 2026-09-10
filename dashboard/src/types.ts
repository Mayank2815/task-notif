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
  /** Write-only, same as the Slack one: needed so a reply is filed under their name. */
  teamworkUserToken?: string;
  hasTeamworkUserToken?: boolean;
  teamworkUserTokenSource?: 'environment' | 'dashboard' | null;
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

export type JobKind = 'reminder' | 'digest' | 'weekly';

/** One row in the "Marked done" list — enough to show it and to take it back. */
export interface DismissalRow {
  recipientId: string;
  recipientLabel: string;
  key: string;
  label: string;
  at: string;
  kind: 'task' | 'slack';
  /** True while Slack still shows an Undo button for it. */
  undoOpen: boolean;
}

export interface ReportPerson {
  recipientId: string;
  label: string;
  completed: { taskId: number; taskName: string; project: string | null; link: string; at: string }[];
  workedOn: { taskId: number; taskName: string; project: string | null; link: string }[];
  comments: number;
  statusChanges: number;
  newlyAssigned: { taskId: number; taskName: string; project: string | null; link: string }[];
}

export interface RangeReport {
  from: string;
  to: string;
  days: number;
  people: ReportPerson[];
  source: 'teamwork';
  stats: { commentsSwept: number; activityEntries: number; durationMs: number };
}

/** A report is built in the background, so the dashboard polls this. */
export interface ReportJob {
  id: string;
  from: string;
  to: string;
  status: 'running' | 'done' | 'failed';
  progress: string[];
  result: RangeReport | null;
  error: string | null;
}

export interface Config {
  teamworkSiteUrl: string;
  recipients: Recipient[];
  jobs: Record<JobKind, Job>;
  timezone: string;
  sendWhenEmpty: boolean;
  enabled: boolean;
  lookbackDays: number;
  undoWindowMinutes: number;
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
