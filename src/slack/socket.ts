import {
  addDismissal, clearUndo, getConfig, getDismissals, removeDismissal, syncUndoMessage,
} from '../config/store.js';
import { TeamworkClient } from '../teamwork/client.js';
import { PeopleDirectory } from '../teamwork/people-directory.js';
import { toTeamworkHtml } from './rich-text.js';
import { envKeyFor } from './mentions.js';
import { DateTime } from 'luxon';
import {
  describeOutcome, loadingView, readSubmission, replyView, validateDueDate, validateSubmission,
  COMPLETE_ACTION, DUE_ACTION, REPLY_ACTION, REPLY_CALLBACK, THREAD_SHOWN,
  type ReplyTask, type Submission, type ThreadComment,
} from './reply.js';

/** The action ids that mark something done; both are undone the same way. */
const DISMISS_ACTIONS = new Set(['dismiss_thread', 'dismiss_task']);
export const UNDO_ACTION = 'undo_dismiss';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

interface Envelope {
  type?: string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

export interface MuteResult {
  /** The rewritten message. */
  blocks: Record<string, unknown>[];
  /** What was lifted out, kept verbatim so Undo can put the row back as it was. */
  removed: Record<string, unknown>[];
}

/** The note that stands in for a dismissed row once its undo window has closed. */
function doneNote(label: string): Record<string, unknown> {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `✅ Done — ${label || 'that thread'} won't appear again` }],
  };
}

/**
 * The same note while undo is still possible. A section rather than a context block
 * because only a section can carry a button, and it must stay one block either way —
 * the message is already budgeted against Slack's fifty-block ceiling.
 */
function undoableNote(label: string, actionValue: string): Record<string, unknown> {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ Done — ${label || 'that thread'} won't appear again` },
    accessory: {
      type: 'button',
      action_id: UNDO_ACTION,
      text: { type: 'plain_text', text: '↩︎ Undo', emoji: true },
      value: actionValue,
    },
  };
}

const valueOf = (b: Record<string, unknown>): string =>
  String((b.accessory as Record<string, unknown> | undefined)?.value ?? '');
const actionOf = (b: Record<string, unknown>): string =>
  String((b.accessory as Record<string, unknown> | undefined)?.action_id ?? '');

/**
 * Replaces a finished thread's two blocks (its section and the metadata under it) with a
 * single note, and decrements the section's count so the header stays honest.
 *
 * Only a row that still carries a dismiss button matches, so Slack re-delivering the
 * same click cannot mute the note that replaced it.
 */
export function muteRow(
  blocks: Record<string, unknown>[],
  actionValue: string,
  label: string,
): MuteResult | null {
  const row = findRow(blocks, actionValue);
  if (!row) return null;

  const out = [...blocks];
  const removed = out.splice(row.index, row.count, undoableNote(label, actionValue));

  return { blocks: out.map((block) => shiftHeader(block, -1)), removed };
}

/**
 * Where a row starts and how many blocks it spans.
 *
 * Rows come in three shapes and all three have to be found by the same key: a section
 * carrying the button itself (a Slack thread, or a task nobody can reply to), that same
 * section with a metadata line under it, and — once replying is on — a section followed
 * by an actions block holding the buttons. Missing a shape here would leave a pressed
 * button sitting on the message with nothing happening.
 */
function findRow(blocks: Record<string, unknown>[], actionValue: string): { index: number; count: number } | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;

    // Buttons in an actions block: the row is the section above it.
    if (block.type === 'actions') {
      const elements = (block.elements as Record<string, unknown>[] | undefined) ?? [];
      const hit = elements.some(
        (e) => String(e.value ?? '') === actionValue && DISMISS_ACTIONS.has(String(e.action_id ?? '')),
      );
      if (hit && i > 0) return { index: i - 1, count: 2 };
      continue;
    }

    if (valueOf(block) !== actionValue || !DISMISS_ACTIONS.has(actionOf(block))) continue;
    // The metadata context block directly beneath belongs to this row.
    return { index: i, count: blocks[i + 1]?.type === 'context' ? 2 : 1 };
  }
  return null;
}

/** How a moved date reads on the row: "Tue 15 Sep". */
const shortDate = (iso: string) => DateTime.fromISO(iso).toFormat('ccc d LLL');

/**
 * Notes a moved due date on the row and leaves its controls in place, with the picker
 * now showing the new date — a wrong pick is fixed by picking again, not in Teamwork.
 * The row stays until the next reminder, which will no longer count it as overdue.
 */
export function markRowMoved(
  blocks: Record<string, unknown>[], rowId: string, date: string,
): Record<string, unknown>[] | null {
  const at = blocks.findIndex((b) => b.type === 'actions' && b.block_id === rowId);
  if (at <= 0 || blocks[at - 1]?.type !== 'section') return null;

  const out = [...blocks];
  const section = out[at - 1]!;
  const current = String((section.text as { text?: string } | undefined)?.text ?? '');
  // Replace an earlier note rather than stacking one per pick.
  const note = `📅 _moved to ${shortDate(date)}_`;
  const text = /\n📅 _moved to [^_]*_$/.test(current)
    ? current.replace(/\n📅 _moved to [^_]*_$/, `\n${note}`)
    : `${current}\n${note}`;
  out[at - 1] = { ...section, text: { type: 'mrkdwn', text } };

  const actions = out[at]!;
  out[at] = {
    ...actions,
    elements: ((actions.elements as Record<string, unknown>[]) ?? []).map((e) =>
      e.type === 'datepicker' ? { ...e, initial_date: date } : e),
  };
  return out;
}

/** A finished task leaves the message, with a line saying so in its place. */
export function markRowCompleted(
  blocks: Record<string, unknown>[], key: string, label: string,
): Record<string, unknown>[] | null {
  const row = findRow(blocks, key);
  if (!row) return null;
  const out = [...blocks];
  out.splice(row.index, row.count, {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `✅ Completed in Teamwork — ${label || 'that task'}` }],
  });
  return out;
}

/**
 * Puts a dismissed row back where it was, button and metadata intact, and restores the
 * count muting took off. Finding the note rather than trusting a stored position keeps
 * this correct when another row was dismissed in between.
 */
export function restoreRow(
  blocks: Record<string, unknown>[],
  actionValue: string,
  removed: Record<string, unknown>[],
): Record<string, unknown>[] | null {
  const index = blocks.findIndex((b) => valueOf(b) === actionValue && actionOf(b) === UNDO_ACTION);
  if (index === -1 || removed.length === 0) return null;

  const out = [...blocks];
  out.splice(index, 1, ...removed);
  return out.map((block) => shiftHeader(block, 1));
}

/**
 * Drops the Undo button once the window closes, leaving the plain note behind. The
 * button is removed rather than left there refusing, because pressing Done has no time
 * limit and a button that quietly stopped working would read as broken.
 */
export function stripUndoButton(
  blocks: Record<string, unknown>[],
  actionValue: string,
  label: string,
): Record<string, unknown>[] | null {
  const index = blocks.findIndex((b) => valueOf(b) === actionValue && actionOf(b) === UNDO_ACTION);
  if (index === -1) return null;

  const out = [...blocks];
  out.splice(index, 1, doneNote(label));
  return out;
}

/** "*💬 Slack — still unanswered* · 5" becomes "· 4" once a row is muted, and back on undo. */
function shiftHeader(block: Record<string, unknown>, by: number): Record<string, unknown> {
  const text = (block.text as Record<string, unknown> | undefined)?.text;
  if (block.type !== 'section' || typeof text !== 'string') return block;

  const match = /^(\*💬 Slack[^*]*\*) · (\d+)$/.exec(text);
  if (!match) return block;

  const next = Math.max(0, Number(match[2]) + by);
  return { ...block, text: { type: 'mrkdwn', text: `${match[1]} · ${next}` } };
}

export type RoutedAction = {
  kind: 'dismiss' | 'undo' | 'reply' | 'complete' | 'due';
  recipientId: string;
  key: string;
  label: string;
  value: string;
  /** Only for 'due': the date that was picked. */
  date?: string;
};

/**
 * What an interaction is asking for.
 *
 * Kept separate and exported because getting this wrong is silent: an action that falls
 * through the routing simply does nothing, with no error anywhere. That is exactly what
 * happened when the reply button first shipped — it was parsed by a rule written for the
 * dismiss buttons and rejected before its own branch was ever reached.
 */
export function routeAction(action: Record<string, unknown>): RoutedAction | null {
  const actionId = String(action.action_id ?? '');
  const kind = DISMISS_ACTIONS.has(actionId) ? 'dismiss'
    : actionId === UNDO_ACTION ? 'undo'
      : actionId === REPLY_ACTION ? 'reply'
        : actionId === COMPLETE_ACTION ? 'complete'
          : actionId === DUE_ACTION ? 'due'
            : null;
  if (!kind) return null;

  // A date picker has no value of its own; its row is named by the block around it.
  const value = kind === 'due' ? String(action.block_id ?? '') : String(action.value ?? '');
  const [recipientId, key, label = ''] = value.split('|');
  if (!recipientId || !key) return null;

  if (kind === 'due') {
    const date = String(action.selected_date ?? '');
    if (!date) return null;
    return { kind, recipientId, key, label, value, date };
  }
  return { kind, recipientId, key, label, value };
}

/**
 * Socket Mode: Slack pushes button clicks down a WebSocket instead of POSTing to a
 * public URL. That is what makes interactive buttons workable from a laptop — the
 * xapp- App-Level Token exists for exactly this, and nothing else here.
 */
export class SlackSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  /** Guards against two connection attempts racing, which Slack counts as two sockets. */
  private connecting = false;
  /** Turns a Slack tag into the Teamwork person it means. Cached for an hour. */
  private readonly people: PeopleDirectory;

  constructor(
    private readonly appToken: string,
    /** Opens and updates modals. Without it the buttons still record, but no view appears. */
    private readonly botToken = '',
    /** Reads a comment in full when a modal asks for it; replies use the person's own. */
    private readonly teamworkToken = '',
    private readonly log: (m: string) => void = (m) => console.log(`[slack-socket] ${m}`),
  ) {
    this.people = new PeopleDirectory(
      () => new TeamworkClient({ siteUrl: getConfig().teamworkSiteUrl, apiToken: this.teamworkToken }),
      this.botToken,
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;

    // Slack rejects extra connections with too_many_websockets, so retire the old
    // one before asking for another.
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try { this.ws.close(); } catch { /* already gone */ }
    }

    let url: string;
    try {
      url = await this.openConnection();
    } catch (err) {
      this.connecting = false;
      this.log(`could not open connection: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.connecting = false;
      this.log('connected — dismiss buttons are live');
    });

    ws.addEventListener('message', (event) => {
      void this.handle(String(event.data), ws);
    });

    ws.addEventListener('close', () => {
      this.connecting = false;
      // Only the live socket may trigger a reconnect; a retired one must not.
      if (!this.stopped && this.ws === ws) {
        this.log('disconnected');
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // 'close' always follows, and that is where reconnection is handled.
    });
  }

  private async openConnection(): Promise<string> {
    const res = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
    });
    const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) throw new Error(data.error ?? 'no url returned');
    return data.url;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts++, RECONNECT_MAX_MS);
    setTimeout(() => void this.connect(), delay);
  }

  private async handle(raw: string, ws: WebSocket): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }

    if (envelope.type === 'hello') return;
    if (envelope.type === 'disconnect') {
      this.log(`slack asked us to reconnect (${envelope.reason ?? 'no reason given'})`);
      ws.close();
      return;
    }

    // A submission is answered in the acknowledgement itself: that is the only way to
    // keep the modal open and show what is wrong next to the field.
    if (envelope.type === 'interactive' && envelope.payload?.type === 'view_submission') {
      const view = envelope.payload.view as Record<string, unknown> | undefined;
      const sub = view?.callback_id === REPLY_CALLBACK ? readSubmission(view) : null;
      const errors = sub ? validateSubmission(sub) : null;
      if (envelope.envelope_id) {
        ws.send(JSON.stringify(errors
          ? { envelope_id: envelope.envelope_id, payload: { response_action: 'errors', errors } }
          : { envelope_id: envelope.envelope_id }));
      }
      if (sub && !errors) await this.submitReply(sub, envelope.payload);
      return;
    }

    // Slack resends anything unacknowledged, so acknowledge before doing the work.
    if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

    if (envelope.type !== 'interactive' || !envelope.payload) return;
    await this.handleAction(envelope.payload);
  }

  private async handleAction(payload: Record<string, unknown>): Promise<void> {
    if (payload.type !== 'block_actions') return;

    const actions = (payload.actions ?? []) as Record<string, unknown>[];
    const responseUrl = typeof payload.response_url === 'string' ? payload.response_url : null;
    const message = payload.message as Record<string, unknown> | undefined;
    const blocks = Array.isArray(message?.blocks) ? (message!.blocks as Record<string, unknown>[]) : null;
    // chat.update needs these later, when the undo window closes; unlike a response_url
    // they do not expire, so the button can be removed however long the agent was down.
    const channel = String((payload.channel as Record<string, unknown> | undefined)?.id ?? '');
    const ts = String(message?.ts ?? '');

    for (const action of actions) {
      const routed = routeAction(action);
      if (!routed) continue;

      if (routed.kind === 'reply') {
        await this.reply(routed, payload);
      } else if (routed.kind === 'complete' || routed.kind === 'due') {
        await this.changeTask(routed, blocks, responseUrl);
      } else if (routed.kind === 'dismiss') {
        await this.dismiss({ ...routed, blocks, responseUrl, channel, ts });
      } else {
        await this.undo({ ...routed, blocks, responseUrl });
      }
    }
  }

  private async dismiss(a: {
    recipientId: string; key: string; label: string; value: string;
    blocks: Record<string, unknown>[] | null; responseUrl: string | null;
    channel: string; ts: string;
  }): Promise<void> {
    const now = new Date();
    const muted = a.blocks ? muteRow(a.blocks, a.value, a.label) : null;

    // Only offer undo when the row was actually rewritten — otherwise there is no
    // button to press and nothing to put back.
    const undo = muted && a.channel && a.ts
      ? {
          blocks: muted.removed,
          message: muted.blocks,
          channel: a.channel,
          ts: a.ts,
          expiresAt: new Date(now.getTime() + getConfig().undoWindowMinutes * 60_000).toISOString(),
        }
      : undefined;

    // Refresh first: any undo already open on this message must see the new version,
    // or removing its button later would revert this dismissal.
    if (muted && a.channel && a.ts) syncUndoMessage(a.channel, a.ts, muted.blocks);
    addDismissal({ recipientId: a.recipientId, key: a.key, at: now.toISOString(), label: a.label, undo });
    this.log(`${a.recipientId} marked ${a.key} done${undo ? ' (undo open)' : ''}`);

    if (!a.responseUrl) return;
    await this.post(a.responseUrl, muted
      ? { replace_original: true, text: 'Reminder updated', blocks: muted.blocks }
      : {
          response_type: 'ephemeral',
          replace_original: false,
          text: `✅ Done — ${a.label || 'that thread'} won't appear in your reminders again.`,
        });
  }

  private async undo(a: {
    recipientId: string; key: string; label: string; value: string;
    blocks: Record<string, unknown>[] | null; responseUrl: string | null;
  }): Promise<void> {
    const held = getDismissals(a.recipientId).find((d) => d.key === a.key);
    const open = held?.undo && held.undo.expiresAt > new Date().toISOString();

    if (!open) {
      // The sweeper normally removes the button first; this covers the click that
      // beats it, and the one on a dismissal already taken back from the dashboard.
      if (held) clearUndo(a.recipientId, a.key);
      this.log(`${a.recipientId} pressed undo on ${a.key} after the window closed`);
      if (!a.responseUrl) return;
      const stripped = a.blocks ? stripUndoButton(a.blocks, a.value, a.label) : null;
      await this.post(a.responseUrl, stripped
        ? { replace_original: true, text: 'Reminder updated', blocks: stripped }
        : {
            response_type: 'ephemeral',
            replace_original: false,
            text: `That undo has expired. You can still bring it back from the dashboard.`,
          });
      return;
    }

    const restored = a.blocks ? restoreRow(a.blocks, a.value, held!.undo!.blocks) : null;
    const { channel, ts } = held!.undo!;
    removeDismissal(a.recipientId, a.key);
    if (restored) syncUndoMessage(channel, ts, restored);
    this.log(`${a.recipientId} undid ${a.key}`);

    if (!a.responseUrl) return;
    await this.post(a.responseUrl, restored
      ? { replace_original: true, text: 'Reminder updated', blocks: restored }
      : {
          response_type: 'ephemeral',
          replace_original: false,
          text: `↩︎ Brought back — ${a.label || 'that thread'} will appear again.`,
        });
  }

  /**
   * Opens the reply modal for the row that was clicked.
   *
   * Slack drops a trigger_id after three seconds, and reading the comment takes longer
   * than that, so a placeholder view opens immediately and is filled in once the comment
   * arrives. Without that the modal would simply never appear on a slow call.
   */
  private async reply(routed: RoutedAction, payload: Record<string, unknown>): Promise<void> {
    const triggerId = String(payload.trigger_id ?? '');
    if (!triggerId) { this.log('reply ignored: no trigger_id'); return; }
    if (!this.botToken) { this.log('reply ignored: the socket has no bot token to open a view with'); return; }

    const taskId = Number(routed.key.replace('task:', ''));
    if (!Number.isFinite(taskId) || taskId <= 0) { this.log(`reply ignored: ${routed.key} is not a task`); return; }

    const task: ReplyTask = { id: taskId, name: routed.label };
    this.log(`${routed.recipientId} opened task ${taskId}`);

    const opened = await this.slack('views.open', { trigger_id: triggerId, view: loadingView(task.name) });
    const viewId = String((opened?.view as { id?: string } | undefined)?.id ?? '');
    if (!viewId) return;

    const read = await this.readTask(taskId);
    const config = getConfig();
    await this.slack('views.update', {
      view_id: viewId,
      view: replyView(
        routed.recipientId,
        // The button's value caps the name at 60 characters so the key always fits, so
        // the title has to come from Teamwork rather than from what was clicked.
        { ...read.task, name: read.task.name || task.name },
        read.thread,
        this.teamworkTokenFor(routed.recipientId) !== null,
        {
          total: read.total,
          handles: config.recipients.find((r) => r.id === routed.recipientId)?.handles ?? [],
          now: DateTime.now().setZone(config.timezone),
        },
      ),
    });
  }

  /**
   * The end of a task's comment thread, with authors, plus the task itself.
   *
   * Two requests side by side. It used to be the task, the comments, then one request
   * per author in turn — 4.3s measured, nearly all of it waiting on names that the
   * comments endpoint will sideload in the same response.
   */
  private async readTask(taskId: number): Promise<{ task: ReplyTask; thread: ThreadComment[]; total: number }> {
    const empty = { task: { id: taskId, name: '' }, thread: [], total: 0 };
    if (!this.teamworkToken) return empty;

    try {
      const config = getConfig();
      const client = new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken: this.teamworkToken });
      const [task, { comments, authors }] = await Promise.all([client.task(taskId), client.commentThread(taskId)]);

      const ordered = [...comments].sort((a, b) => (a.postedAt ?? '').localeCompare(b.postedAt ?? ''));
      // The people in this thread are the likeliest to be tagged in the reply, and their
      // real handles are sitting in these comments' HTML.
      this.people.learn(comments.map((c) => c.htmlBody));
      // Warm the people lists now, while the person reads, not when they press Save.
      void this.people.load().catch((err: Error) => this.log(`could not load people: ${err.message}`));
      const meta = [
        task?.projectName, task?.stageName, task?.dueDate ? `due ${task.dueDate}` : null,
      ].filter(Boolean).join('  ·  ');

      return {
        task: { id: taskId, name: task?.name ?? '', link: task?.url, meta: meta || undefined },
        total: ordered.length,
        thread: ordered.slice(-THREAD_SHOWN).map((c) => {
          const who = c.authorId ? authors.get(c.authorId) : undefined;
          return { author: who?.name ?? 'Someone', avatarUrl: who?.avatarUrl ?? null, at: c.postedAt ?? '', body: c.body };
        }),
      };
    } catch (err) {
      this.log(`could not read task ${taskId}: ${(err as Error).message}`);
      return empty;
    }
  }

  /**
   * Moves a due date or completes a task straight from its row, as that person.
   *
   * The row is rewritten to say what happened: a finished task leaves the message, and a
   * moved one keeps its controls with the new date shown, so a wrong pick can be picked
   * again rather than needing Teamwork to fix.
   */
  private async changeTask(
    routed: RoutedAction, blocks: Record<string, unknown>[] | null, responseUrl: string | null,
  ): Promise<void> {
    const taskId = Number(routed.key.replace('task:', ''));
    const say = (text: string) => responseUrl
      ? this.post(responseUrl, { response_type: 'ephemeral', replace_original: false, text })
      : Promise.resolve();

    const token = this.teamworkTokenFor(routed.recipientId);
    if (!token || !Number.isFinite(taskId) || taskId <= 0) {
      this.log(`${routed.recipientId} ${routed.kind} on ${routed.key} refused: no token of their own`);
      await say('This needs your own Teamwork token, so the change is made as you.');
      return;
    }

    const config = getConfig();
    if (routed.kind === 'due') {
      const problem = validateDueDate(routed.date!, DateTime.now().setZone(config.timezone).toISODate() ?? '');
      if (problem) { await say(problem); return; }
    }

    const client = new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken: token });
    try {
      if (routed.kind === 'due') await client.setDueDate(taskId, routed.date!);
      else await client.completeTask(taskId);
    } catch (err) {
      this.log(`${routed.recipientId} ${routed.kind} on task ${taskId} failed: ${(err as Error).message}`);
      await say(`⚠️ Teamwork did not accept that: ${(err as Error).message}`);
      return;
    }
    this.log(`${routed.recipientId} ${routed.kind === 'due' ? `moved task ${taskId} to ${routed.date}` : `completed task ${taskId}`}`);

    const updated = blocks
      ? routed.kind === 'due'
        ? markRowMoved(blocks, routed.value, routed.date!)
        : markRowCompleted(blocks, routed.value, routed.label)
      : null;
    if (updated && responseUrl) {
      await this.post(responseUrl, { replace_original: true, text: 'Reminder updated', blocks: updated });
    } else {
      await say(routed.kind === 'due' ? `📅 Moved to ${routed.date}.` : '✅ Completed in Teamwork.');
    }
  }

  /**
   * Saves what the modal asked for, as that person, and tells them how it went.
   *
   * A reply goes first and completion second: a reply explaining why the task is being
   * closed is worth having even if closing it then fails. Whatever happens is sent back
   * as a message — the modal has already closed, and silence would read as success.
   */
  private async submitReply(sub: Submission, payload: Record<string, unknown>): Promise<void> {
    const userId = String((payload.user as { id?: string } | undefined)?.id ?? '');
    const tell = (text: string) => userId ? this.slack('chat.postMessage', { channel: userId, text }) : Promise.resolve(null);

    const token = this.teamworkTokenFor(sub.recipientId);
    if (!token) {
      this.log(`${sub.recipientId} tried to reply without a Teamwork token — refused`);
      await tell('Nothing was posted: replying needs your own Teamwork token.');
      return;
    }

    const config = getConfig();
    const client = new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken: token });
    const done: string[] = [];
    let skipped: string[] = [];
    try {
      if (sub.rich) {
        if (sub.mentions.length) await this.people.load();
        const { html, notify, unresolved } = toTeamworkHtml(sub.rich, this.people.resolve, this.people.slackName);
        skipped = unresolved;
        await client.postComment(sub.taskId, html, { html: true, notify });
        const tagged = sub.mentions.map((id) => this.people.resolve(id)?.name).filter(Boolean);
        done.push(tagged.length ? `reply posted, ${tagged.join(', ')} notified` : 'reply posted');
      }
      if (sub.complete) {
        await client.completeTask(sub.taskId);
        done.push('marked complete');
      }
      this.log(`${sub.recipientId} on task ${sub.taskId}: ${done.join(', ')}`);
      const note = skipped.length
        ? `\n_Not in Teamwork, so not tagged: ${skipped.join(', ')}._`
        : '';
      await tell(describeOutcome(sub.taskName, done, null) + note);
    } catch (err) {
      const step = sub.rich && done.length === 0 ? 'post the reply' : 'mark it complete';
      this.log(`${sub.recipientId} on task ${sub.taskId}: ${step} failed — ${(err as Error).message}`);
      await tell(describeOutcome(sub.taskName, done, { step, reason: (err as Error).message }));
    }
  }

  /** This person's own Teamwork token, from the environment first, then the store. */
  private teamworkTokenFor(recipientId: string): string | null {
    if (!recipientId) return null;
    const fromEnv = process.env[envKeyFor('TEAMWORK_USER_TOKEN', recipientId)];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    const stored = getConfig().recipients.find((r) => r.id === recipientId)?.teamworkUserToken ?? '';
    return stored.trim().length > 0 ? stored.trim() : null;
  }

  /** One Slack Web API call with the bot token. Modals are the only user of this. */
  private async slack(method: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown> & { ok: boolean; error?: string };
      if (!data.ok) {
        this.log(`${method} failed: ${data.error ?? 'unknown'}`);
        return null;
      }
      return data;
    } catch (err) {
      this.log(`${method} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async post(url: string, body: unknown): Promise<void> {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }
}
