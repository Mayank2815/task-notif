import { DateTime } from 'luxon';
import type { RecipientResult } from '../pipeline.js';
import { cleanTaskName } from '../teamwork/identity.js';
import { paginate } from './paginate.js';
import { taskActions } from './reply.js';
import type { SlackMention } from './mentions.js';

const SNIPPET_MAX = 180;
/** Slack rejects the whole message past 50 blocks, so the budget is enforced, not hoped for. */
export const MAX_BLOCKS = 50;

export interface BlockSection {
  /** Rendered only when the section keeps at least one item. */
  header: unknown[];
  /** One entry per row; a row may be several blocks and is never split. */
  items: unknown[][];
  /** Rendered when items had to be trimmed. */
  more: (hidden: number) => unknown;
}

/**
 * Fits sections inside the block ceiling by trimming whole rows from whichever
 * section is currently longest, so no single section is starved.
 */
export function assembleWithBudget(intro: unknown[], sections: BlockSection[], max = MAX_BLOCKS): unknown[] {
  const shown = sections.map((s) => s.items.length);

  const size = () =>
    intro.length +
    sections.reduce((total, section, i) => {
      const count = shown[i] ?? 0;
      if (count === 0) return total;
      const items = section.items.slice(0, count).reduce((n, blocks) => n + blocks.length, 0);
      const moreNote = count < section.items.length ? 1 : 0;
      return total + section.header.length + items + moreNote;
    }, 0);

  while (size() > max) {
    let target = -1;
    let largest = 0;
    for (let i = 0; i < shown.length; i++) {
      const count = shown[i] ?? 0;
      if (count > largest) { largest = count; target = i; }
    }
    if (target === -1) break; // nothing left to trim
    shown[target] = largest - 1;
  }

  const out = [...intro];
  sections.forEach((section, i) => {
    const count = shown[i] ?? 0;
    if (count === 0) return;
    out.push(...section.header);
    for (const blocks of section.items.slice(0, count)) out.push(...blocks);
    const hidden = section.items.length - count;
    if (hidden > 0) out.push(section.more(hidden));
  });
  return out;
}

/** Slack's mrkdwn treats these as control characters and they must be escaped in any interpolated text. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url: string, label: string): string {
  return `<${url}|${esc(label)}>`;
}

export interface RenderedMessage {
  text: string;
  blocks: unknown[];
  /** Coloured groups. Slack only exposes colour through attachments. */
  attachments?: unknown[];
  /** Further messages, sent straight after, when everything would not fit in one. */
  continuation?: { text: string; blocks: unknown[] }[];
}

/** One colour per reason, so urgency reads before the words do. */
const GROUP_COLOUR: Record<string, string> = {
  'awaiting-response': '#a371f7',
  'action-requested': '#d29922',
  overdue: '#f85149',
  slack: '#4c8dff',
};

/** Redder the longer it has been sitting. */
function ageMarker(days: number): string {
  if (days >= 30) return '🔴';
  if (days >= 7) return '🟠';
  return '🟡';
}

export function renderReminder(
  result: RecipientResult,
  timezone: string,
  slackAwaiting: SlackMention[] = [],
  note?: string,
  yesterdaySummary: string | null = null,
  /** The period the stand-up covers. On a Monday it spans the whole weekend. */
  standupLabel: string | null = null,
  standupDays = 1,
  /** Adds the read-in-full / reply button. One block for the whole message, not per row. */
  canReply = false,
): RenderedMessage {
  const name = result.recipient.label || result.identity.displayName;
  const now = DateTime.now().setZone(timezone);
  const today = now.toFormat('cccc, d LLLL');
  const yesterdayLabel = standupLabel ?? now.minus({ days: 1 }).toFormat('cccc, d LLLL');
  const standupTitle = standupDays > 1 ? `Last ${standupDays} days` : 'Yesterday';

  if (result.total === 0 && slackAwaiting.length === 0 && !yesterdaySummary) {
    return {
      text: `Nothing pending — ${today}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅ All clear', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(today)} · nothing needs you right now` }] },
      ],
    };
  }

  const totalItems = result.total + slackAwaiting.length;

  const tally = [
    ...result.groups.map((g) => `${groupEmoji(g.ruleId)} ${g.items.length} ${shortLabel(g.ruleId)}`),
    slackAwaiting.length > 0 ? `💬 ${slackAwaiting.length} slack` : null,
  ].filter(Boolean).join('   ');

  const intro: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `Good morning, ${name.split(' ')[0]}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(today)}${note ? `  ·  ${esc(note)}` : ''}` }] },
  ];

  // Yesterday first: it is the half you read out, and stand-up comes before the day's work.
  if (yesterdaySummary) {
    intro.push(sectionHeading(`🗣️ ${standupTitle} — ${yesterdayLabel}`));
    intro.push(...summarySections(yesterdaySummary));
    intro.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_for stand-up_' }] });
  }

  intro.push({ type: 'divider' });
  if (totalItems === 0) {
    // Only reached with a stand-up to send and an empty list under it. The tally would be
    // an empty line, and Slack rejects a block with empty text — and the whole message with it.
    intro.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '✅ _Nothing needs you today._' }] });
  } else {
    intro.push(sectionHeading(`📋 Needs you today · ${totalItems}`));
    intro.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tally }] });
  }

  const sections: BlockSection[] = result.groups.map((group) => ({
    // Top level, not inside an attachment: Slack only renders a header block large
    // at the top level, which is what makes a heading read as a heading.
    header: [
      { type: 'section', text: { type: 'mrkdwn', text: `${groupEmoji(group.ruleId)}  *${esc(group.label)}*  ·  ${group.items.length}` } },
    ],
    items: group.items.map((item, index) =>
      taskRow(item, group.ruleId, index + 1, result.recipient.id, canReply)),
    more: (hidden: number) => ({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_…and ${hidden} more_` }],
    }),
  }));

  if (slackAwaiting.length > 0) {
    sections.push({
      header: [
        { type: 'section', text: { type: 'mrkdwn', text: `💬  *Slack — still unanswered*  ·  ${slackAwaiting.length}` } },
      ],
      items: slackAwaiting.map((m) => slackRow(m, result.recipient.id)),
      more: (hidden: number) => ({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_…and ${hidden} more_` }],
      }),
    });
  }

  // Every row is sent. Nothing is trimmed to fit: past Slack's fifty blocks the rest
  // follows as a second message. On 14 September the trimming would have hidden 11 of one
  // person's 29 tasks — four to a twelve-row cap, seven to the block ceiling.
  return paginate({
    text: totalItems === 0 ? `Your stand-up — ${today}` : `${totalItems} items need your attention — ${today}`,
    blocks: assembleWithBudget(intro, sections, Number.POSITIVE_INFINITY),
  });
}

/** One task, numbered so it can be referred to out loud in stand-up. */
function taskRow(
  item: RecipientResult['groups'][number]['items'][number],
  ruleId: string,
  position: number,
  recipientId: string,
  canReply: boolean,
): unknown[] {
  const { task, match, assigneeNames } = item;
  const title = link(match.link, cleanTaskName(task.name));

  // An overdue row is fixed by moving it or finishing it; a question row by answering it.
  // Either way the controls need the person's own token, so nothing is posted under
  // somebody else's name — without one the row keeps its single Done button.
  const kind = ruleId === 'overdue' ? 'update' : 'reply';
  const actions = taskActions(recipientId, task.id, cleanTaskName(task.name), {
    canAct: canReply, kind, dueDate: task.dueDate,
  });
  const doneButton = (actions.elements as Record<string, unknown>[])[0];

  if (ruleId === 'overdue') {
    const days = Number(/Overdue by (\d+)/i.exec(match.detail)?.[1] ?? 0);
    const age = days > 0 ? `${ageMarker(days)} ${days}d` : '🟡 today';
    const meta = [task.projectName ? esc(task.projectName) : null, task.stageName ? esc(task.stageName) : null]
      .filter(Boolean).join('  ·  ');
    const body = { type: 'mrkdwn', text: `\`${position}\`  ${age}   *${title}*\n${' '.repeat(6)}${meta}` };

    // Costs one more block than the plain row. Measured in block-budget.test: with
    // twelve overdue rows and twelve questions it trims four rows from a full message,
    // which the budget absorbs with an "…and N more" line rather than dropping silently.
    return canReply
      ? [{ type: 'section', text: body }, actions]
      : [{ type: 'section', text: body, accessory: doneButton }];
  }

  const meta = [
    task.projectName ? esc(task.projectName) : null,
    assigneeNames.length ? esc(assigneeNames.join(', ')) : 'unassigned',
    task.dueDate ? `due ${esc(friendlyDate(task.dueDate))}` : null,
  ].filter(Boolean).join('  ·  ');

  // The metadata moves up into the section so the actions block costs nothing: the row
  // still spans two blocks, exactly as it did with a context line underneath.
  if (canReply) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`${position}\`  *${title}*\n>${esc(truncate(match.detail, SNIPPET_MAX))}\n${meta}`,
        },
      },
      actions,
    ];
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`${position}\`  *${title}*\n>${esc(truncate(match.detail, SNIPPET_MAX))}` },
      accessory: doneButton,
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: meta }] },
  ];
}

/** Slack refuses a section whose text passes 3,000 characters — and with it the whole message. */
const SECTION_MAX = 3000;

/**
 * A summary as one or more sections, each inside Slack's limit, split only between its
 * lines so no link is ever cut in half.
 *
 * One section used to carry the whole summary. A week of activity measured 3,720
 * characters in it, and Slack rejected the entire weekly message for that one block —
 * the recipient got nothing (11 September). A three-day Monday stand-up grows the same way.
 */
export function summarySections(summary: string, heading = ''): Record<string, unknown>[] {
  const lines = (heading ? `${heading}\n${summary}` : summary).split('\n').map(fitLine);
  const out: Record<string, unknown>[] = [];
  let current = '';
  for (const line of lines) {
    const joined = current ? `${current}\n${line}` : line;
    if (joined.length > SECTION_MAX && current) {
      out.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
      current = line;
    } else {
      current = joined;
    }
  }
  if (current) out.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
  return out;
}

/**
 * A single line too long for any section is cut at the last "; " between its items, so
 * the cut falls between two links rather than through one. String length counts emoji as
 * two, which only ever makes this stricter than Slack's own count.
 */
function fitLine(line: string): string {
  if (line.length <= SECTION_MAX) return line;
  const cut = line.lastIndexOf('; ', SECTION_MAX - 2);
  return `${line.slice(0, cut > 0 ? cut : SECTION_MAX - 1)}…`;
}

/** Slack header blocks are plain text only, capped at 150 characters. */
export function sectionHeading(text: string): unknown {
  return { type: 'header', text: { type: 'plain_text', text: text.slice(0, 150), emoji: true } };
}

function shortLabel(ruleId: string): string {
  switch (ruleId) {
    case 'awaiting-response': return 'to reply';
    case 'action-requested': return 'asked of you';
    case 'overdue': return 'overdue';
    default: return 'other';
  }
}

/**
 * One thread per row: where it is, then the message, then a Mute button.
 * The button carries recipient and thread key so the Socket Mode handler can
 * record the dismissal without any lookup.
 */
export function slackRow(m: SlackMention, recipientId: string): unknown[] {
  const where = m.isDm ? `DM from ${m.author}` : `#${m.channelName}`;
  // The button acts on this one thread; say so, because the row header is a channel name.
  const label = m.isDm ? `this DM with ${m.author}` : `this thread in #${m.channelName}`;
  const handled = m.answeredByOther && m.otherRespondents.length > 0
    ? `  ·  ↩️ ${esc(m.otherRespondents.join(', '))} replied`
    : '';

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${link(m.permalink, where)}*\n>${esc(truncate(m.text, SNIPPET_MAX))}` },
      accessory: {
        type: 'button',
        action_id: 'dismiss_thread',
        text: { type: 'plain_text', text: '🔕 Mute', emoji: true },
        // Slack caps a button value at 2000 chars.
        value: `${recipientId}|${m.key}|${where}`.slice(0, 2000),
      },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(m.author)}  ·  ${esc(friendlyDate(m.at.slice(0, 10)))}${handled}` }] },
  ];
}

export function renderSlackRows(mentions: SlackMention[], recipientId: string): unknown[] {
  return mentions.flatMap((m) => slackRow(m, recipientId));
}

/** "Overdue by 49 days (due 16 Jul 2026)" -> "49 days overdue" */
function shortOverdue(detail: string): string {
  const m = /Overdue by (\d+) days?/i.exec(detail);
  if (m) return `${m[1]} days overdue`;
  return detail.replace(/\s*\(due [^)]*\)/, '');
}

/** "2026-07-16" -> "16 Jul" — the year is noise for anything this side of a birthday. */
function friendlyDate(iso: string): string {
  const d = DateTime.fromISO(iso);
  if (!d.isValid) return iso;
  return d.year === DateTime.now().year ? d.toFormat('d LLL') : d.toFormat('d LLL yyyy');
}

function groupEmoji(ruleId: string): string {
  switch (ruleId) {
    case 'awaiting-response': return '💬';
    case 'action-requested': return '🙋';
    case 'overdue': return '⏰';
    default: return '•';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
