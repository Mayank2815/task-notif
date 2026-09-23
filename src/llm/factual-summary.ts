import { hoursAndMinutes, type Digest } from '../digest.js';
import { cleanTaskName } from '../teamwork/identity.js';

const NAME_MAX = 58; // long enough to recognise a ticket, short enough to keep a line scannable

/**
 * Scrum and standing-meeting tasks collect time every day, but they are not work anyone
 * reads out at stand-up. Seen in this workspace: "AD: Daily scrum, coordination, planning
 * and weekly status calls", "Meetings, discussions and scrum", "Reusable Automation
 * Services Daily Scrum". Kept out of "Worked on" — not out of the digest's time record.
 */
const SCRUM = /\bscrum\b/i;
export const isStandupWork = (t: { taskName: string }): boolean => !SCRUM.test(t.taskName);

/**
 * The stand-up summary, assembled from the digest's own facts.
 * No model, no network, no data leaving the machine — and it cannot invent anything,
 * because every clause is derived from a counted list.
 *
 * Returns Slack mrkdwn: task names are links, so a scrum master can be pointed straight
 * at the ticket while it is read out. Interpolated text is escaped here, so callers must
 * NOT escape the result again.
 */
export function buildFactualSummary(digest: Digest, slackConnected = true): string | null {
  const lines: string[] = [];

  // Several comments on one task is still one task; the summary counts work, not chatter.
  // Worked on = commented on OR logged time on. Time alone is often the only trace: an
  // afternoon of code leaves no comment. Most time first, so the biggest piece of work
  // is the one read out first; a task commented on without logged time follows.
  const time = (digest.timeLogged ?? []).filter(isStandupWork);
  const minutesOn = new Map(time.map((t) => [t.taskId, t.minutes]));
  const commented = uniqueByTask(digest.updates).filter(isStandupWork);
  const worked = [
    ...commented,
    ...time.filter((t) => !commented.some((c) => c.taskId === t.taskId)),
  ].sort((a, b) => (minutesOn.get(b.taskId) ?? 0) - (minutesOn.get(a.taskId) ?? 0));
  const totalMinutes = time.reduce((n, t) => n + t.minutes, 0);
  const withTime = (t: { taskId: number; taskName: string; taskLink?: string; link: string; stage: string | null }) =>
    `${taskWithStage(t)}${minutesOn.get(t.taskId) ? ` · ${hoursAndMinutes(minutesOn.get(t.taskId)!)}` : ''}`;
  const done = uniqueByTask(digest.updates.filter((u) => u.isDone));
  const blocked = uniqueByTask(digest.updates.filter((u) => u.isBlocker));
  const prs = digest.updates.flatMap((u) => u.prLinks.map((url) => ({ url, from: u })));

  if (worked.length > 0) {
    const logged = totalMinutes > 0 ? ` · ${hoursAndMinutes(totalMinutes)} logged` : '';
    // Every task, one to a line. Stand-up goes through each of them, so "+4 more" hid
    // exactly the work that had to be read out. Sections split between lines, so a long
    // list is carried across several blocks rather than cut.
    lines.push([`*Worked on ${count(worked.length, 'task')}*${logged}`, ...worked.map((t) => `      ◦ ${withTime(t)}`)].join('\n'));
  }

  if (done.length > 0) {
    lines.push(`*Dev done* — ${done.slice(0, 4).map(taskWithStage).join('; ')}${more(done.length, 4)}`);
  }

  if (prs.length > 0) {
    // Which PR belongs to which ticket is the thing that gets asked in stand-up.
    const byTask = new Map<number, { name: string; taskLink: string; urls: string[] }>();
    for (const { url, from } of prs) {
      const entry = byTask.get(from.taskId) ?? { name: from.taskName, taskLink: from.taskLink, urls: [] };
      entry.urls.push(url);
      byTask.set(from.taskId, entry);
    }
    const parts = [...byTask.values()].map(
      (e) => `${e.urls.map((u, i) => link(u, e.urls.length > 1 ? `PR ${i + 1}` : 'PR')).join(' ')} on ${link(e.taskLink, trim(e.name))}`,
    );
    lines.push(`*Raised ${count(prs.length, 'PR')}* — ${parts.join('; ')}`);
  }

  if (digest.completed.length > 0) {
    lines.push(`*Closed ${count(digest.completed.length, 'task')}* — ${digest.completed.slice(0, 4).map(taskWithStage).join('; ')}${more(digest.completed.length, 4)}`);
  }

  if (blocked.length > 0) {
    lines.push(`*Blocked / waiting* — ${blocked.slice(0, 3).map(taskWithStage).join('; ')}${more(blocked.length, 3)}`);
  }

  if (digest.newlyAssigned.length > 0) {
    lines.push(`*New today* — ${digest.newlyAssigned.slice(0, 3).map(taskWithStage).join('; ')}${more(digest.newlyAssigned.length, 3)}`);
  }

  // Each answer named, so you can judge which is worth raising rather than a bare count.
  if (digest.meetings.length > 0) {
    lines.push(`*Calls* — ${digest.meetings.slice(0, 3).map((m) => link(m.permalink, esc(m.channel))).join('; ')}${more(digest.meetings.length, 3)}`);
  }

  if (digest.slackActivity.length > 0) {
    const top = digest.slackActivity.slice(0, 4).map((a) => `${link(a.permalink, esc(a.channel))} (${a.messages})`);
    lines.push(`*Talked in* — ${top.join('; ')}${more(digest.slackActivity.length, 4)}`);
  }

  // One entry per task or conversation, not per comment. Two unanswered comments on one
  // task read out as the same task twice (14 September: one reviewer commented twice on
  // the same task and it was listed twice), and two replies in one channel likewise.
  const answered = [
    ...grouped(digest.mentionsAnswered, (m) => `tw:${m.taskId ?? m.link}`,
      (m, authors) => `${authors} on ${link(m.link, trim(m.taskName))}`),
    ...grouped(digest.slackReplied, (m) => slackKey(m),
      (m, authors) => `${authors} in ${link(m.permalink, m.isDm ? 'DM' : `#${m.channelName}`)}`),
  ];
  if (answered.length > 0) {
    lines.push(`*Answered ${answered.length}* — ${answered.slice(0, 5).join('; ')}${more(answered.length, 5)}`);
  }

  const open = [
    ...grouped(digest.mentionsOpen, (m) => `tw:${m.taskId ?? m.link}`,
      (m, authors) => `${link(m.link, trim(m.taskName))} (${authors})`),
    ...grouped(digest.slackAwaiting, (m) => slackKey(m),
      (m, authors) => `${link(m.permalink, m.isDm ? `DM from ${m.author}` : `#${m.channelName}`)} (${authors})`),
  ];

  if (lines.length === 0 && open.length === 0) return null;

  // Without a Slack user token the Slack half is invisible, so "nothing waiting" would
  // be an absolute claim made from half the evidence — read out at stand-up, in front of
  // a lead. Say what was actually looked at instead.
  lines.push(
    open.length > 0
      ? `*Still open* — ${open.slice(0, 5).join('; ')}${more(open.length, 5)}`
      : slackConnected
        ? '*Still open* — nothing waiting on a reply.'
        : '*Still open* — nothing waiting in Teamwork.',
  );

  if (!slackConnected) {
    lines.push('_Slack is not connected for this account, so nothing above covers Slack._');
  }

  return lines.map((l) => `• ${l}`).join('\n');
}

/** "Ticket name (Ready for QA)" — the column is what a scrum master searches the board for. */
function taskWithStage(t: { taskName: string; taskLink?: string; link: string; stage: string | null }): string {
  const label = link(t.taskLink ?? t.link, trim(t.taskName));
  return t.stage ? `${label} _(${esc(t.stage)})_` : label;
}

function uniqueByTask<T extends { taskId: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((i) => (seen.has(i.taskId) ? false : (seen.add(i.taskId), true)));
}

/**
 * One entry per key, in first-seen order, carrying every distinct author for it — so
 * merging two comments never drops the name of someone who asked.
 */
function grouped<T extends { author: string }>(
  items: T[], key: (item: T) => string, render: (first: T, authors: string) => string,
): string[] {
  const byKey = new Map<string, { first: T; authors: string[] }>();
  for (const item of items) {
    const k = key(item);
    const entry = byKey.get(k) ?? { first: item, authors: [] };
    if (!entry.authors.includes(item.author)) entry.authors.push(item.author);
    byKey.set(k, entry);
  }
  return [...byKey.values()].map((e) => render(e.first, e.authors.map(esc).join(', ')));
}

/** A DM is one conversation per person; a channel is one conversation however many threads. */
function slackKey(m: { isDm: boolean; author: string; channelName: string }): string {
  return m.isDm ? `dm:${m.author}` : `ch:${m.channelName}`;
}

function more(total: number, shown: number): string {
  return total > shown ? `; +${total - shown} more` : '';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function trim(name: string): string {
  const clean = cleanTaskName(name);
  return esc(clean.length <= NAME_MAX ? clean : `${clean.slice(0, NAME_MAX - 1).trimEnd()}…`);
}

function link(url: string, label: string): string {
  return url ? `<${url}|${label}>` : label;
}

/** Slack mrkdwn control characters. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
