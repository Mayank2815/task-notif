/** Slack caps a plain-text input at 3000 characters; leave room for the rest of the view. */
const REPLY_MAX = 2500;
/** A comment long enough to fill a modal is long enough to read in Teamwork instead. */
const SHOWN_MAX = 2800;

export const REPLY_OPEN_ACTION = 'open_reply';
export const REPLY_PICK_ACTION = 'pick_reply_task';
export const REPLY_CALLBACK = 'reply_to_task';
export const REPLY_INPUT_BLOCK = 'reply_body_block';
export const REPLY_INPUT_ACTION = 'reply_body';

export interface ReplyTask {
  id: number;
  name: string;
}

/**
 * The tasks a message is offering, read back out of the message itself.
 *
 * The Done button on every task row already carries `recipient|task:<id>|<name>`, so the
 * list can be rebuilt at click time without storing anything alongside the message.
 */
export function tasksInMessage(blocks: Record<string, unknown>[]): ReplyTask[] {
  const seen = new Map<number, ReplyTask>();
  for (const block of blocks) {
    const accessory = block.accessory as Record<string, unknown> | undefined;
    if (accessory?.action_id !== 'dismiss_task') continue;
    const [, key, name = ''] = String(accessory.value ?? '').split('|');
    const id = Number(String(key ?? '').replace('task:', ''));
    if (Number.isFinite(id) && id > 0 && !seen.has(id)) seen.set(id, { id, name });
  }
  return [...seen.values()];
}

/** The single block that offers the whole thing, so no row loses space to a second button. */
export function replyButtonBlock(recipientId: string): Record<string, unknown> {
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      action_id: REPLY_OPEN_ACTION,
      text: { type: 'plain_text', text: '💬 Read in full / reply', emoji: true },
      value: recipientId,
    }],
  };
}

const text = (t: string) => ({ type: 'mrkdwn' as const, text: t });

/** Step one: which task. Names only, so the view opens inside Slack's three seconds. */
export function pickerView(recipientId: string, tasks: ReplyTask[]): Record<string, unknown> {
  if (tasks.length === 0) {
    return {
      type: 'modal',
      callback_id: REPLY_CALLBACK,
      title: { type: 'plain_text', text: 'Reply to a task' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: text('This message has no Teamwork tasks to reply to.') }],
    };
  }

  return {
    type: 'modal',
    callback_id: REPLY_CALLBACK,
    private_metadata: JSON.stringify({ recipientId }),
    title: { type: 'plain_text', text: 'Reply to a task' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: text('Pick a task to read the comment in full and reply to it.'),
        accessory: {
          type: 'static_select',
          action_id: REPLY_PICK_ACTION,
          placeholder: { type: 'plain_text', text: 'Choose a task' },
          options: tasks.slice(0, 100).map((t) => ({
            // Slack rejects an empty label and truncates at 75.
            text: { type: 'plain_text', text: (t.name || `Task ${t.id}`).slice(0, 75) },
            value: String(t.id),
          })),
        },
      },
    ],
  };
}

/**
 * Step two: the comment as it actually reads, and a box to answer it.
 *
 * The reminder truncates a comment to a couple of lines because a message carrying twelve
 * of them cannot do otherwise. This is where the rest of it lives.
 */
export function replyView(
  recipientId: string,
  task: ReplyTask,
  comment: { author: string; at: string; body: string } | null,
  canPost: boolean,
): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: text(`*${task.name || `Task ${task.id}`}*`) },
  ];

  if (comment) {
    blocks.push({ type: 'context', elements: [text(`${comment.author} · ${comment.at.slice(0, 10)}`)] });
    blocks.push({ type: 'section', text: text(comment.body.slice(0, SHOWN_MAX) || '_(empty comment)_') });
  } else {
    blocks.push({ type: 'section', text: text('_No comment found on this task._') });
  }

  blocks.push({ type: 'divider' });

  if (canPost) {
    blocks.push({
      type: 'input',
      block_id: REPLY_INPUT_BLOCK,
      label: { type: 'plain_text', text: 'Your reply' },
      element: {
        type: 'plain_text_input',
        action_id: REPLY_INPUT_ACTION,
        multiline: true,
        max_length: REPLY_MAX,
        placeholder: { type: 'plain_text', text: 'This is posted on the task as you.' },
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
    ...(canPost ? { submit: { type: 'plain_text', text: 'Post comment' } } : {}),
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

/** What the submitted view carries back: who, which task, and what they wrote. */
export function readSubmission(view: Record<string, unknown>): {
  recipientId: string; taskId: number; taskName: string; body: string;
} | null {
  let meta: { recipientId?: string; taskId?: number; taskName?: string };
  try {
    meta = JSON.parse(String(view.private_metadata ?? '{}'));
  } catch {
    return null;
  }
  if (!meta.recipientId || !meta.taskId) return null;

  const values = (view.state as { values?: Record<string, Record<string, { value?: string }>> })?.values ?? {};
  const body = values[REPLY_INPUT_BLOCK]?.[REPLY_INPUT_ACTION]?.value ?? '';
  if (body.trim().length === 0) return null;

  return { recipientId: meta.recipientId, taskId: meta.taskId, taskName: meta.taskName ?? '', body: body.trim() };
}
