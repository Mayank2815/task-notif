import { clearUndo, expiredUndos, syncUndoMessage } from '../config/store.js';
import { SlackClient } from './client.js';
import { stripUndoButton } from './socket.js';

/** The window is measured in minutes, so checking once a minute is precise enough. */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * How long to keep retrying a message that will not update. A deleted message fails
 * forever, and the click path strips a stale button anyway, so give up after a day.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

/**
 * Takes the Undo button off a message once its window has closed.
 *
 * Pressing Done has no time limit, so a button left sitting there refusing would read
 * as broken — it has to go. It cannot go on a timer, because the agent restarts often
 * and a timer would not survive; the expiry lives in the store instead and this sweep
 * picks up anything overdue, however long the machine was off.
 */
export class UndoSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly botToken: string,
    private readonly log: (m: string) => void = (m) => console.log(`[undo] ${m}`),
  ) {}

  start(): void {
    if (this.timer) return;
    // Run once up front: anything that expired while the process was down is overdue now.
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<void> {
    for (const d of expiredUndos(now)) {
      if (!d.undo) continue;
      const { channel, ts, message, expiresAt } = d.undo;
      const value = `${d.recipientId}|${d.key}|${d.label}`;
      const stripped = stripUndoButton(message, value, d.label);

      // The note carries no button any more — nothing to remove, just close the window.
      if (!stripped) {
        clearUndo(d.recipientId, d.key);
        continue;
      }

      const failure = await this.update(channel, ts, stripped);
      if (!failure) {
        syncUndoMessage(channel, ts, stripped);
        clearUndo(d.recipientId, d.key);
        this.log(`undo window closed for ${d.recipientId} ${d.key}`);
        continue;
      }

      if (now.getTime() - new Date(expiresAt).getTime() > GIVE_UP_AFTER_MS) {
        clearUndo(d.recipientId, d.key);
        this.log(`giving up on ${d.recipientId} ${d.key}: ${failure}`);
      } else {
        this.log(`could not close ${d.recipientId} ${d.key} (${failure}) — retrying`);
      }
    }
  }

  /** Returns null on success, or the reason it failed. */
  private async update(channel: string, ts: string, blocks: Record<string, unknown>[]): Promise<string | null> {
    try {
      await new SlackClient(this.botToken).updateMessage(channel, ts, blocks);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }
}
