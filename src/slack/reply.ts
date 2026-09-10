import { DateTime } from 'luxon';
import { mentionedUsers, plainText, type RichElement } from './rich-text.js';

/** Enough of one comment to read it properly; five of them still fit a modal comfortably. */
const SHOWN_MAX = 1200;
/** Slack caps a button value at 2000; the label is trimmed so the key always survives. */
const NAME_MAX = 60;
/**
 * How much of the thread to show. Answering well needs what was said before the last
 * message, not just the last message — but a modal is not the place to read a year of
 * history, and Slack caps a view at 100 blocks (five comments take fifteen).
 */
export const THREAD_SHOWN = 5;

export const REPLY_ACTION = 'reply_task';
export const COMPLETE_ACTION = 'complete_task';
export const DUE_ACTION = 'set_due';
export const REPLY_CALLBACK = 'reply_to_task';
export const REPLY_INPUT_BLOCK = 'reply_body_block';
export const REPLY_INPUT_ACTION = 'reply_body';
export const COMPLETE_BLOCK = 'complete_block';
export const COMPLETE_INPUT_ACTION = 'complete';

export interface ReplyTask {
  id: number;
  name: string;
  link?: string;
  /** Project · stage · due, the line that says where the task stands. */
  meta?: string;
}

export interface ThreadComment {
  author: string;
  avatarUrl?: string | null;
  at: string;
  body: string;
}

const text = (t: string) => ({ type: 'mrkdwn' as const, text: t });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The key a row's controls carry: whose message, which task, and a readable name. */
export const rowKey = (recipientId: string, taskId: number, name: string): string =>
  `${recipientId}|task:${taskId}|${name.slice(0, NAME_MAX)}`.slice(0, 1990);

/**
 * Everything a task row can do.
 *
 * Without a token of their own the row keeps the single one-click Done it has always had.
 * With one, the controls sit in an actions block beneath the row, side by side, so none
 * is buried behind another:
 *
 *  - a question row gets Hide and Reply;
 *  - an overdue row gets a date picker, Complete, Comment and Hide — the fixes for an
 *    overdue task are to move it or finish it, so those come first.
 *
 * "Done" is renamed "Hide" wherever Complete also appears: two buttons called Done and
 * Complete would invite pressing the one that only hides the task, leaving it open in
 * Teamwork with nobody the wiser.
 */
export function taskActions(
  recipientId: string,
  taskId: number,
  name: string,
  opts: { canAct: boolean; kind?: 'reply' | 'update'; dueDate?: string | null } = { canAct: false },
): Record<string, unknown> {
  const key = rowKey(recipientId, taskId, name);
  const button = (actionId: string, label: string, extra: Record<string, unknown> = {}) => ({
    type: 'button', action_id: actionId, text: { type: 'plain_text', text: label, emoji: true }, value: key, ...extra,
  });

  if (!opts.canAct) {
    return { type: 'actions', elements: [button('dismiss_task', '✅ Done')] };
  }

  const hide = button('dismiss_task', '🔕 Hide');

  if (opts.kind !== 'update') {
    return { type: 'actions', block_id: key.slice(0, 255), elements: [button(REPLY_ACTION, '💬 Read / reply'), hide] };
  }

  const initial = opts.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.dueDate) ? { initial_date: opts.dueDate } : {};
  return {
    type: 'actions',
    // A date picker carries no value of its own, so the row is named by the block.
    block_id: key.slice(0, 255),
    elements: [
      {
        type: 'datepicker',
        action_id: DUE_ACTION,
        placeholder: { type: 'plain_text', text: '📅 Move due date' },
        ...initial,
      },
      button(COMPLETE_ACTION, '✅ Complete', {
        style: 'primary',
        // Finishing a task changes it for everyone on it, so it asks first.
        confirm: {
          title: { type: 'plain_text', text: 'Complete this task?' },
          text: text(`Marks *${esc(name.slice(0, 200))}* complete in Teamwork, for everyone on it.`),
          confirm: { type: 'plain_text', text: 'Complete' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      }),
      button(REPLY_ACTION, '💬 Comment'),
      hide,
    ],
  };
}

/** "today", "yesterday", "3 days ago", then a date — the way a thread is actually read. */
export function whenSaid(iso: string, now: DateTime): string {
  const at = DateTime.fromISO(iso).setZone(now.zone);
  if (!at.isValid) return '';
  const days = Math.floor(now.startOf('day').diff(at.startOf('day'), 'days').days);
  if (days <= 0) return `today ${at.toFormat('HH:mm')}`;
  if (days === 1) return `yesterday ${at.toFormat('HH:mm')}`;
  if (days < 7) return `${days} days ago`;
  return at.toFormat(at.year === now.year ? 'd LLL' : 'd LLL yyyy');
}

/** Path segments that say nothing about which page a link is. */
const FILLER = new Set(['details', 'view', 'edit', 'overview', 'index', 'show']);

/**
 * A long link as something readable: "amazon.com › pull-requests/47210" instead of a
 * 140-character address wrapping across three lines of a fixed-width modal. The full
 * address is still what the link opens.
 */
export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    const parts = u.pathname.split('/').filter((p) => p && !FILLER.has(p.toLowerCase()));
    const tail = parts.slice(-2).join('/');
    const label = tail ? `${host} › ${tail}` : host;
    return label.length > 60 ? `${label.slice(0, 57)}…` : label;
  } catch {
    return url.slice(0, 60);
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>|]+/g;

/** Escapes the words and turns each bare address into a short, clickable label. */
function linkify(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_PATTERN)) {
    // A sentence ending in a link leaves its full stop outside it.
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    out += esc(text.slice(last, m.index)) + `<${url}|🔗 ${esc(shortLink(url))}>`;
    last = m.index! + url.length;
  }
  return out + esc(text.slice(last));
}

/** Slack's quote bar on every line, so each comment reads as a block of its own. */
const quote = (body: string) =>
  linkify(body.slice(0, SHOWN_MAX)).split('\n').map((line) => `>${line}`).join('\n') || '>_(empty comment)_';

/** Shown while the thread is fetched, so the modal opens inside Slack's three seconds. */
export function loadingView(taskName: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: REPLY_CALLBACK,
    title: { type: 'plain_text', text: 'Reply to a task' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: text(`*${esc((taskName || 'This task').slice(0, 200))}*`) },
      { type: 'context', elements: [text('_Loading the conversation…_')] },
    ],
  };
}

/**
 * The conversation as it actually reads, and a box to answer it.
 *
 * Each comment gets its author's photo and name on a line of its own, its text behind a
 * quote bar, and a rule underneath — without that a thread of five runs together into
 * one wall of text. The newest sits at the bottom, next to the reply box, the way every
 * chat reads; the ones naming you are marked, since those are usually the reason you
 * are here.
 */
export function replyView(
  recipientId: string,
  task: ReplyTask,
  /** Oldest first. */
  thread: ThreadComment[],
  canPost: boolean,
  opts: { total?: number; handles?: string[]; now?: DateTime } = {},
): Record<string, unknown> {
  const now = opts.now ?? DateTime.now();
  const total = opts.total ?? thread.length;
  const handles = (opts.handles ?? []).map((h) => h.toLowerCase().replace(/^@/, ''));
  const title = esc((task.name || `Task ${task.id}`).slice(0, 500));

  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: text(task.link ? `*<${task.link}|${title}>*` : `*${title}*`) },
  ];
  if (task.meta) blocks.push({ type: 'context', elements: [text(esc(task.meta))] });

  if (thread.length === 0) {
    blocks.push({ type: 'section', text: text('_No comments on this task yet._') });
  } else {
    if (total > thread.length) {
      const all = task.link ? ` · <${task.link}|see all in Teamwork>` : '';
      blocks.push({ type: 'context', elements: [text(`_Last ${thread.length} of ${total} comments_${all}`)] });
    }
    blocks.push({ type: 'divider' });

    thread.forEach((c, i) => {
      const isLatest = i === thread.length - 1;
      const namesYou = handles.some((h) => h && c.body.toLowerCase().includes(`@${h}`));
      const tags = [isLatest ? '🆕 latest' : null, namesYou ? '🔔 mentions you' : null].filter(Boolean).join('  ·  ');

      const byline: Record<string, unknown>[] = [];
      if (c.avatarUrl) byline.push({ type: 'image', image_url: c.avatarUrl, alt_text: c.author });
      byline.push(text(`*${esc(c.author)}*  ·  ${whenSaid(c.at, now)}${tags ? `  ·  ${tags}` : ''}`));

      blocks.push({ type: 'context', elements: byline });
      blocks.push({ type: 'section', text: text(quote(c.body)) });
      blocks.push({ type: 'divider' });
    });
  }

  if (canPost) {
    // Rich text rather than a plain box: it is the same composer as Slack's own message
    // field, so typing @ brings up the people picker, and bold, lists and links carry
    // through to Teamwork.
    blocks.push({
      type: 'input',
      block_id: REPLY_INPUT_BLOCK,
      optional: true,
      label: { type: 'plain_text', text: 'Your reply' },
      element: {
        type: 'rich_text_input',
        action_id: REPLY_INPUT_ACTION,
        // The modal's width is Slack's to decide, so the room has to come from height:
        // a box that starts at eight lines and grows to fifteen before it scrolls. Eight
        // was asked for after five still felt cramped for a real reply.
        min_lines: 8,
        max_lines: 15,
        // Opening the modal to answer something, so the cursor starts in the box.
        focus_on_load: true,
        placeholder: { type: 'plain_text', text: 'Type @ to tag someone — only the people you tag are notified.' },
      },
    });
    blocks.push({
      type: 'input',
      block_id: COMPLETE_BLOCK,
      optional: true,
      label: { type: 'plain_text', text: 'Finish it' },
      element: {
        type: 'checkboxes',
        action_id: COMPLETE_INPUT_ACTION,
        options: [{ text: { type: 'plain_text', text: 'Also mark the task complete in Teamwork' }, value: 'complete' }],
      },
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [text(
        '_Replying needs your own Teamwork token, so the comment is filed under your name ' +
        'rather than somebody else\'s. Ask for it to be added and this box appears._',
      )],
    });
  }

  return {
    type: 'modal',
    callback_id: REPLY_CALLBACK,
    private_metadata: JSON.stringify({ recipientId, taskId: task.id, taskName: task.name }),
    title: { type: 'plain_text', text: 'Reply to a task' },
    ...(canPost ? { submit: { type: 'plain_text', text: 'Save' } } : {}),
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

export interface Submission {
  recipientId: string;
  taskId: number;
  taskName: string;
  /** What they typed, as Slack's rich text — null when they only finished the task. */
  rich: RichElement | null;
  /** The words alone, to tell a real reply from an empty box. */
  text: string;
  /** Slack ids of everyone they tagged, in order. */
  mentions: string[];
  complete: boolean;
}

/** What the submitted view carries back: who, which task, and what they asked for. */
export function readSubmission(view: Record<string, unknown>): Submission | null {
  let meta: { recipientId?: string; taskId?: number; taskName?: string };
  try {
    meta = JSON.parse(String(view.private_metadata ?? '{}'));
  } catch {
    return null;
  }
  if (!meta.recipientId || !meta.taskId) return null;

  type Field = { rich_text_value?: RichElement | null; selected_options?: { value?: string }[] };
  const values = (view.state as { values?: Record<string, Record<string, Field>> })?.values ?? {};
  const rich = values[REPLY_INPUT_BLOCK]?.[REPLY_INPUT_ACTION]?.rich_text_value ?? null;
  const text = plainText(rich);
  const mentions = mentionedUsers(rich);

  return {
    recipientId: meta.recipientId,
    taskId: meta.taskId,
    taskName: meta.taskName ?? '',
    // A tag on its own still counts as saying something.
    rich: text || mentions.length ? rich : null,
    text,
    mentions,
    complete: (values[COMPLETE_BLOCK]?.[COMPLETE_INPUT_ACTION]?.selected_options ?? [])
      .some((o) => o.value === 'complete'),
  };
}

/**
 * Why a submission cannot be saved, keyed by the block to show it against, or null.
 * Checked before Slack is acknowledged, so the modal stays open with the message next to
 * the field instead of closing on nothing.
 */
export function validateSubmission(sub: Submission): Record<string, string> | null {
  if (!sub.rich && !sub.complete) {
    return { [REPLY_INPUT_BLOCK]: 'Write a reply, or tick the box to mark it complete.' };
  }
  return null;
}

/** A due date chosen from the row. Refuses a date already gone, which would leave it overdue. */
export function validateDueDate(date: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'That is not a date Teamwork will take.';
  if (date < today) return 'Pick today or a later date — an earlier one leaves it overdue.';
  return null;
}

/** One line saying what actually happened, for the confirmation sent after saving. */
export function describeOutcome(
  taskName: string,
  done: string[],
  failed: { step: string; reason: string } | null,
): string {
  const name = `*${esc(taskName || 'the task')}*`;
  if (!failed) return `✅ ${name} — ${done.join(' · ')}`;
  const before = done.length ? ` Already done: ${done.join(' · ')}.` : '';
  return `⚠️ Could not ${failed.step} on ${name}: ${failed.reason}.${before}`;
}
