import { DateTime } from 'luxon';
import type { RecipientResult } from '../pipeline.js';
import type { SlackMention } from './mentions.js';

const MAX_ITEMS_PER_GROUP = 12;
const MAX_SLACK_ROWS = 8;
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
}

export function renderReminder(
  result: RecipientResult,
  timezone: string,
  slackAwaiting: SlackMention[] = [],
  note?: string,
): RenderedMessage {
  const name = result.recipient.label || result.identity.displayName;
  const today = DateTime.now().setZone(timezone).toFormat('cccc, d LLLL');

  if (result.total === 0 && slackAwaiting.length === 0) {
    return {
      text: `Nothing pending — ${today}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅ Nothing pending', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(today)} · no tasks need your attention` }] },
      ],
    };
  }

  const totalItems = result.total + slackAwaiting.length;
  const intro: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📋 ${totalItems} item${totalItems === 1 ? '' : 's'} need your attention`, emoji: true },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(today)} · for ${esc(name)}${note ? `  ·  ${esc(note)}` : ''}` }] },
  ];

  const sections: BlockSection[] = result.groups.map((group) => ({
    header: [
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*${groupEmoji(group.ruleId)} ${esc(group.label)}* · ${group.items.length}` } },
    ],
    items: group.items.slice(0, MAX_ITEMS_PER_GROUP).map(({ task, match, assigneeNames }) => {
      const meta = [
        task.projectName ? esc(task.projectName) : null,
        assigneeNames.length ? esc(assigneeNames.join(', ')) : 'unassigned',
        task.dueDate ? `due ${esc(task.dueDate)}` : null,
      ].filter(Boolean).join('  ·  ');

      return [
        { type: 'section', text: { type: 'mrkdwn', text: `*${link(match.link, task.name)}*\n_${esc(truncate(match.detail, SNIPPET_MAX))}_` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: meta }] },
      ];
    }),
    more: (hidden: number) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${hidden + Math.max(0, group.items.length - MAX_ITEMS_PER_GROUP)} more_` }] }),
  }));

  if (slackAwaiting.length > 0) {
    sections.push({
      header: [
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: `*💬 Slack — still unanswered* · ${slackAwaiting.length}` } },
      ],
      items: slackAwaiting.slice(0, MAX_SLACK_ROWS).map((m) => slackRow(m, result.recipient.id)),
      more: (hidden: number) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${hidden + Math.max(0, slackAwaiting.length - MAX_SLACK_ROWS)} more_` }] }),
    });
  }

  return { text: `${totalItems} items need your attention — ${today}`, blocks: assembleWithBudget(intro, sections) };
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
      text: { type: 'mrkdwn', text: `*${link(m.permalink, where)}*\n_${esc(truncate(m.text, SNIPPET_MAX))}_` },
      accessory: {
        type: 'button',
        action_id: 'dismiss_thread',
        text: { type: 'plain_text', text: '🔕 Mute', emoji: true },
        // Slack caps a button value at 2000 chars.
        value: `${recipientId}|${m.key}|${where}`.slice(0, 2000),
      },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(m.author)}  ·  ${esc(m.at.slice(0, 10))}${handled}` }] },
  ];
}

export function renderSlackRows(mentions: SlackMention[], recipientId: string): unknown[] {
  const rows = mentions.slice(0, MAX_SLACK_ROWS).flatMap((m) => slackRow(m, recipientId));
  if (mentions.length > MAX_SLACK_ROWS) {
    rows.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${mentions.length - MAX_SLACK_ROWS} more_` }] });
  }
  return rows;
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
