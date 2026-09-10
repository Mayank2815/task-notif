import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The store resolves its directory once, at import time, so this has to be set first.
const dir = mkdtempSync(join(tmpdir(), 'undo-sweeper-'));
process.env.DATA_DIR = dir;

const { addDismissal, getDismissals } = await import('../config/store.js');
const { muteRow } = await import('../slack/socket.js');
const { UndoSweeper } = await import('../slack/undo-sweeper.js');

const VALUE = 'alice|task:9001|Widget';
const rows = (): Record<string, unknown>[] => [
  { type: 'section', text: { type: 'mrkdwn', text: '*💬 Slack — still unanswered* · 2' } },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '`1` *Widget*' },
    accessory: { type: 'button', action_id: 'dismiss_task', value: VALUE },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'meta' }] },
];

/** Captures what would have gone to Slack instead of sending it. */
function stubFetch(response: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return { status: 200, headers: new Headers(), json: async () => response } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const store = (past: boolean) => {
  const muted = muteRow(rows(), VALUE, 'Widget')!;
  addDismissal({
    recipientId: 'alice', key: 'task:9001', at: new Date().toISOString(), label: 'Widget',
    undo: {
      blocks: muted.removed,
      message: muted.blocks,
      channel: 'D123',
      ts: '1788242536.831209',
      expiresAt: new Date(Date.now() + (past ? -60_000 : 60_000)).toISOString(),
    },
  });
};

test.after(() => rmSync(dir, { recursive: true, force: true }));

await test('an expired window is closed by updating the message', async () => {
  store(true);
  const f = stubFetch({ ok: true });
  try {
    await new UndoSweeper('xoxb-test', () => {}).sweep();
  } finally {
    f.restore();
  }

  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.url, /chat\.update$/);
  assert.equal(f.calls[0]!.body.channel, 'D123');
  assert.equal(f.calls[0]!.body.ts, '1788242536.831209');

  // The button is gone from what was sent, and the done note remains.
  const sent = JSON.stringify(f.calls[0]!.body.blocks);
  assert.ok(!sent.includes('undo_dismiss'), 'the undo button should not survive the sweep');
  assert.ok(sent.includes('Done'));

  // The dismissal itself stands — only the undo state is dropped.
  const held = getDismissals('alice').find((d) => d.key === 'task:9001');
  assert.ok(held, 'the item must stay marked done');
  assert.equal(held!.undo, undefined);
});

await test('a window still open is left alone', async () => {
  store(false);
  const f = stubFetch({ ok: true });
  try {
    await new UndoSweeper('xoxb-test', () => {}).sweep();
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 0, 'nothing should be sent while the window is open');
  assert.ok(getDismissals('alice').find((d) => d.key === 'task:9001')?.undo);
});

await test('a failed update keeps the undo state for the next sweep', async () => {
  store(true);
  const f = stubFetch({ ok: false, error: 'message_not_found' });
  try {
    await new UndoSweeper('xoxb-test', () => {}).sweep();
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 1);
  assert.ok(
    getDismissals('alice').find((d) => d.key === 'task:9001')?.undo,
    'a transient failure must not silently leave the button stranded',
  );
});
