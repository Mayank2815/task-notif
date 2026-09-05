import { addDismissal } from '../config/store.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

interface Envelope {
  type?: string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

/**
 * Replaces a finished thread's two blocks (its section and the metadata under it) with a
 * single note, and decrements the section's count so the header stays honest.
 */
export function muteRow(
  blocks: Record<string, unknown>[],
  actionValue: string,
  label: string,
): Record<string, unknown>[] | null {
  const index = blocks.findIndex(
    (b) => ((b.accessory as Record<string, unknown> | undefined)?.value ?? '') === actionValue,
  );
  if (index === -1) return null;

  // The metadata context block directly beneath belongs to this row.
  const trailing = blocks[index + 1];
  const removeCount = trailing?.type === 'context' ? 2 : 1;

  const out = [...blocks];
  out.splice(index, removeCount, {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `✅ Done — ${label || 'that thread'} won't appear again` }],
  });

  return out.map((block) => decrementHeader(block));
}

/** "*💬 Slack — still unanswered* · 5" becomes "· 4" once a row is muted. */
function decrementHeader(block: Record<string, unknown>): Record<string, unknown> {
  const text = (block.text as Record<string, unknown> | undefined)?.text;
  if (block.type !== 'section' || typeof text !== 'string') return block;

  const match = /^(\*💬 Slack[^*]*\*) · (\d+)$/.exec(text);
  if (!match) return block;

  const next = Math.max(0, Number(match[2]) - 1);
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
    await this.handleAction(envelope.payload);
  }

  private async handleAction(payload: Record<string, unknown>): Promise<void> {
    if (payload.type !== 'block_actions') return;

    const actions = (payload.actions ?? []) as Record<string, unknown>[];
    const responseUrl = typeof payload.response_url === 'string' ? payload.response_url : null;

    for (const action of actions) {
      // Slack threads and Teamwork tasks are dismissed the same way; only the key differs.
      if (action.action_id !== 'dismiss_thread' && action.action_id !== 'dismiss_task') continue;

      const [recipientId, key, label] = String(action.value ?? '').split('|');
      if (!recipientId || !key) continue;

      addDismissal({ recipientId, key, at: new Date().toISOString(), label: label ?? '' });
      this.log(`${recipientId} marked ${key} done`);
      if (!responseUrl) continue;

      // Rewrite the row in place so the button goes away — clicking Mute twice is
      // harmless but looks broken.
      const original = (payload.message as Record<string, unknown> | undefined)?.blocks;
      const updated = Array.isArray(original)
        ? muteRow(original as Record<string, unknown>[], String(action.value ?? ''), label ?? '')
        : null;

      const body = updated
        ? { replace_original: true, text: 'Reminder updated', blocks: updated }
        : {
            response_type: 'ephemeral',
            replace_original: false,
            text: `✅ Done — ${label || 'that thread'} won't appear in your reminders again.`,
          };

      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    }
  }
}
