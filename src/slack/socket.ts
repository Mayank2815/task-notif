import {
  addDismissal, clearUndo, getConfig, getDismissals, removeDismissal, syncUndoMessage,
} from '../config/store.js';
import { TeamworkClient } from '../teamwork/client.js';
import { envKeyFor } from './mentions.js';
import {
  pickerView, readSubmission, replyView, tasksInMessage,
  REPLY_CALLBACK, REPLY_OPEN_ACTION, REPLY_PICK_ACTION, type ReplyTask,
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
  const index = blocks.findIndex((b) => valueOf(b) === actionValue && DISMISS_ACTIONS.has(actionOf(b)));
  if (index === -1) return null;

  // The metadata context block directly beneath belongs to this row.
  const trailing = blocks[index + 1];
  const removeCount = trailing?.type === 'context' ? 2 : 1;

  const out = [...blocks];
  const removed = out.splice(index, removeCount, undoableNote(label, actionValue));

  return { blocks: out.map((block) => shiftHeader(block, -1)), removed };
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

  constructor(
    private readonly appToken: string,
    /** Opens and updates modals. Without it the buttons still record, but no view appears. */
    private readonly botToken = '',
    /** Reads a comment in full when a modal asks for it; replies use the person's own. */
    private readonly teamworkToken = '',
    private readonly log: (m: string) => void = (m) => console.log(`[slack-socket] ${m}`),
  ) {}

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

    // Slack resends anything unacknowledged, so acknowledge before doing the work.
    if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

    if (envelope.type !== 'interactive' || !envelope.payload) return;
    if (envelope.payload.type === 'view_submission') {
      await this.submitReply(envelope.payload);
      return;
    }
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
      const actionId = String(action.action_id ?? '');
      const value = String(action.value ?? '');
      const [recipientId, key, label = ''] = value.split('|');
      if (!recipientId || !key) continue;

      if (actionId === REPLY_OPEN_ACTION || actionId === REPLY_PICK_ACTION) {
        await this.reply(actionId, action, payload);
        continue;
      }
      if (DISMISS_ACTIONS.has(actionId)) {
        await this.dismiss({ recipientId, key, label, value, blocks, responseUrl, channel, ts });
      } else if (actionId === UNDO_ACTION) {
        await this.undo({ recipientId, key, label, value, blocks, responseUrl });
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

  /** Opens the reply modal, and fills it in once a task is chosen. */
  private async reply(
    actionId: string, action: Record<string, unknown>, payload: Record<string, unknown>,
  ): Promise<void> {
    const triggerId = String(payload.trigger_id ?? '');
    if (!triggerId || !this.botToken) return;

    if (actionId === REPLY_OPEN_ACTION) {
      const recipientId = String(action.value ?? '');
      const message = payload.message as Record<string, unknown> | undefined;
      const blocks = Array.isArray(message?.blocks) ? (message!.blocks as Record<string, unknown>[]) : [];
      const tasks = tasksInMessage(blocks);
      this.log(`${recipientId} opened reply (${tasks.length} task(s) offered)`);
      await this.slack('views.open', { trigger_id: triggerId, view: pickerView(recipientId, tasks) });
      return;
    }

    // A task was chosen: fetch the comment itself, then swap the view for the full text.
    const view = payload.view as Record<string, unknown> | undefined;
    const viewId = String(view?.id ?? '');
    const selected = (action.selected_option as Record<string, unknown> | undefined)?.value;
    const taskId = Number(selected ?? 0);
    if (!viewId || !taskId) return;

    let meta: { recipientId?: string } = {};
    try { meta = JSON.parse(String(view?.private_metadata ?? '{}')); } catch { /* keep empty */ }
    const recipientId = meta.recipientId ?? '';
    const label = (action.selected_option as { text?: { text?: string } } | undefined)?.text?.text ?? '';
    const task: ReplyTask = { id: taskId, name: label };

    const latest = await this.latestComment(taskId);
    await this.slack('views.update', {
      view_id: viewId,
      view: replyView(recipientId, task, latest, this.teamworkTokenFor(recipientId) !== null),
    });
  }

  /** The newest comment on a task, in full — what the reminder had to cut short. */
  private async latestComment(taskId: number): Promise<{ author: string; at: string; body: string } | null> {
    if (!this.teamworkToken) return null;
    try {
      const config = getConfig();
      const client = new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken: this.teamworkToken });
      const comments = await client.comments(taskId);
      const newest = comments.sort((a, b) => (a.postedAt ?? '').localeCompare(b.postedAt ?? '')).pop();
      if (!newest) return null;
      const person = newest.authorId ? await client.person(newest.authorId) : null;
      const author = [person?.firstName, person?.lastName].filter(Boolean).join(' ') || 'Someone';
      return { author, at: newest.postedAt ?? '', body: newest.body };
    } catch (err) {
      this.log(`could not read task ${taskId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Posts the reply, using that person's own Teamwork token so the comment is filed
   * under their name. Refused outright when they have no token — a comment under the
   * wrong name in the system of record is worse than no comment at all.
   */
  private async submitReply(payload: Record<string, unknown>): Promise<void> {
    const view = payload.view as Record<string, unknown> | undefined;
    if (!view || view.callback_id !== REPLY_CALLBACK) return;

    const sub = readSubmission(view);
    if (!sub) return;

    const token = this.teamworkTokenFor(sub.recipientId);
    if (!token) {
      this.log(`${sub.recipientId} tried to reply without a Teamwork token — refused`);
      return;
    }

    try {
      const config = getConfig();
      const client = new TeamworkClient({ siteUrl: config.teamworkSiteUrl, apiToken: token });
      const id = await client.postComment(sub.taskId, sub.body);
      this.log(`${sub.recipientId} commented on task ${sub.taskId} (comment ${id})`);
    } catch (err) {
      this.log(`${sub.recipientId} could not comment on task ${sub.taskId}: ${(err as Error).message}`);
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
  private async slack(method: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) this.log(`${method} failed: ${data.error ?? 'unknown'}`);
    } catch (err) {
      this.log(`${method} failed: ${(err as Error).message}`);
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
