import type { Digest } from '../digest.js';
import { cleanTaskName } from '../teamwork/identity.js';

const NAME_MAX = 58; // long enough to recognise a ticket, short enough to keep a line scannable

/**
 * The stand-up summary, assembled from the digest's own facts.
 * No model, no network, no data leaving the machine — and it cannot invent anything,
 * because every clause is derived from a counted list.
 *
 * Returns Slack mrkdwn: task names are links, so a scrum master can be pointed straight
 * at the ticket while it is read out. Interpolated text is escaped here, so callers must
 * NOT escape the result again.
 */
export function buildFactualSummary(digest: Digest): string | null {
  const lines: string[] = [];

  // Several comments on one task is still one task; the summary counts work, not chatter.
  const worked = uniqueByTask(digest.updates);
  const done = uniqueByTask(digest.updates.filter((u) => u.isDone));
  const blocked = uniqueByTask(digest.updates.filter((u) => u.isBlocker));
  const prs = digest.updates.flatMap((u) => u.prLinks.map((url) => ({ url, from: u })));

  if (worked.length > 0) {
    lines.push(`*Worked on ${count(worked.length, 'task')}* — ${worked.slice(0, 4).map(taskWithStage).join('; ')}${more(worked.length, 4)}`);
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
  const answered = [
    ...digest.mentionsAnswered.map((m) => `${esc(m.author)} on ${link(m.link, trim(m.taskName))}`),
    ...digest.slackReplied.map((m) => `${esc(m.author)} in ${link(m.permalink, m.isDm ? 'DM' : `#${m.channelName}`)}`),
  ];
  if (answered.length > 0) {
    lines.push(`*Answered ${answered.length}* — ${answered.slice(0, 5).join('; ')}${more(answered.length, 5)}`);
  }

  const open = [
    ...digest.mentionsOpen.map((m) => `${link(m.link, trim(m.taskName))} (${esc(m.author)})`),
    ...digest.slackAwaiting.map((m) => `${link(m.permalink, m.isDm ? `DM from ${m.author}` : `#${m.channelName}`)} (${esc(m.author)})`),
  ];

  if (lines.length === 0 && open.length === 0) return null;

  lines.push(
    open.length > 0
      ? `*Still open* — ${open.slice(0, 5).join('; ')}${more(open.length, 5)}`
      : '*Still open* — nothing waiting on a reply.',
  );

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
