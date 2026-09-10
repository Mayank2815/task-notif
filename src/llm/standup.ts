import type { Config } from '../config/schema.js';
import type { Digest } from '../digest.js';
import { buildFactualSummary } from './factual-summary.js';
import { generate } from './gemini.js';

/**
 * Facts sent to Gemini. DM text is withheld by default — a DM is the most private
 * thing this tool touches, and the summary rarely needs its contents.
 */
export function buildPrompt(digest: Digest, includeDmText: boolean, slackConnected = true): string {
  const lines: string[] = [];

  const add = (heading: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push(`${heading}:`);
    for (const e of entries) lines.push(`- ${e}`);
    lines.push('');
  };

  add('Tasks I commented on', digest.updates.map((u) => {
    const tags = [u.isDone ? 'marked done' : null, u.isBlocker ? 'mentions a blocker' : null].filter(Boolean).join(', ');
    const prs = u.prLinks.length ? ` [${u.prLinks.length} PR link(s)]` : '';
    return `"${u.taskName}" (${u.project ?? 'no project'})${tags ? ` [${tags}]` : ''}${prs}: ${u.text}`;
  }));

  add('Tasks I completed', digest.completed.map((c) => `"${c.taskName}" (${c.project ?? 'no project'})`));
  add('Other changes I made', digest.statusChanges.map((s) => s.description));
  add('New work assigned to me today', digest.newlyAssigned.map((t) => `"${t.taskName}" (${t.project ?? 'no project'})`));

  add('Teamwork questions still waiting on me', digest.mentionsOpen.map((m) => `"${m.taskName}" — ${m.author}: ${m.text}`));
  add('Teamwork questions I answered', digest.mentionsAnswered.map((m) => `"${m.taskName}" — ${m.author}`));

  const describe = (m: Digest['slackAwaiting'][number]) => {
    const where = m.isDm ? `DM from ${m.author}` : `#${m.channelName}`;
    if (m.isDm && !includeDmText) return `${where} (content withheld)`;
    return `${where} — ${m.author}: ${m.text}`;
  };

  add('Slack threads still waiting on me', digest.slackAwaiting.map(describe));
  add('Slack threads I handled', digest.slackReplied.map(describe));

  return [
    'You are writing a short stand-up update for a software engineer, based only on the facts below.',
    'Write 3-6 short bullet points covering: what they worked on and finished, anything that looks blocked,',
    'and anything new or unplanned that came up. End with one line on what is still outstanding.',
    '',
    'Rules:',
    '- Use only the facts given. Do not invent tasks, names, statuses or progress.',
    '- Write plainly, first person, past tense. No preamble, no heading, no sign-off.',
    '- Keep each bullet to one line. Prefer concrete task names over vague phrasing.',
    '- If the facts are thin, say so briefly rather than padding.',
    ...(slackConnected
      ? []
      : [
          '- Slack was NOT searched for this person. Say nothing about Slack, and do not claim',
          '  that nothing is outstanding — you have only seen their Teamwork activity.',
        ]),
    '',
    '--- FACTS ---',
    lines.join('\n').trim() || '(no recorded activity today)',
  ].join('\n');
}

/**
 * The stand-up summary. Gemini writes it when enabled and reachable; otherwise it is
 * assembled locally from the same facts. There is always a summary — the model only
 * changes how it reads.
 */
export async function writeStandupSummary(
  digest: Digest,
  config: Config,
  log: (m: string) => void = () => {},
  slackConnected = true,
): Promise<string | null> {
  if (digest.total === 0) return null;

  const fallback = buildFactualSummary(digest, slackConnected);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!config.standupSummaryEnabled || !apiKey) return fallback;

  try {
    const summary = await generate(apiKey, buildPrompt(digest, config.standupSummaryIncludeDmText, slackConnected));
    if (summary) {
      log('standup summary written by Gemini');
      return summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    log('gemini returned nothing — using the locally assembled summary');
  } catch (err) {
    log(`gemini unavailable (${(err as Error).message}) — using the locally assembled summary`);
  }
  return fallback;
}
