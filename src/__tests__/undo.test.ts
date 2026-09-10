import assert from 'node:assert/strict';
import test from 'node:test';
import { muteRow, restoreRow, stripUndoButton, UNDO_ACTION } from '../slack/socket.js';

const VALUE = 'alice|G01A5LG5ZPX:1788242536.831209|#team_workflow_dev';
const OTHER = 'alice|G011LCJNCHZ:1|#team_frontend_dev';

const blocks = (): Record<string, unknown>[] => [
  { type: 'header', text: { type: 'plain_text', text: '📋 24 items need your attention' } },
  { type: 'section', text: { type: 'mrkdwn', text: '*💬 Slack — still unanswered* · 5' } },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*#team_workflow_dev*\n_@Vinod_' },
    accessory: { type: 'button', action_id: 'dismiss_thread', value: VALUE },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Dev Kapoor · 2026-09-01' }] },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*#team_frontend_dev*\n_Sure will check_' },
    accessory: { type: 'button', action_id: 'dismiss_thread', value: OTHER },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Arjun Rao · 2026-09-02' }] },
];

const accessoryOf = (b: Record<string, unknown>) => b.accessory as { action_id?: string; value?: string } | undefined;
const noteIn = (bs: Record<string, unknown>[]) => bs.find((b) => accessoryOf(b)?.action_id === UNDO_ACTION);

test('muting hands back the blocks it removed', () => {
  const { removed } = muteRow(blocks(), VALUE, '#chan')!;
  assert.equal(removed.length, 2);
  assert.deepEqual(removed, blocks().slice(2, 4));
});

test('the done note offers an Undo button carrying the same key', () => {
  const { blocks: out } = muteRow(blocks(), VALUE, '#chan')!;
  const note = noteIn(out);
  assert.ok(note, 'expected an undo button on the note');
  assert.equal(accessoryOf(note!)!.value, VALUE);
});

test('undo puts the row back exactly as it was', () => {
  const original = blocks();
  const { blocks: muted, removed } = muteRow(original, VALUE, '#chan')!;
  const restored = restoreRow(muted, VALUE, removed)!;
  assert.deepEqual(restored, original);
});

test('undo restores the count that muting took off', () => {
  const { blocks: muted, removed } = muteRow(blocks(), VALUE, '#chan')!;
  const header = (bs: Record<string, unknown>[]) =>
    String((bs.find((b) => String((b.text as { text?: string })?.text ?? '').includes('Slack —'))!
      .text as { text: string }).text);
  assert.match(header(muted), /· 4$/);
  assert.match(header(restoreRow(muted, VALUE, removed)!), /· 5$/);
});

test('undoing one row leaves another dismissed row alone', () => {
  const first = muteRow(blocks(), VALUE, '#chan')!;
  const second = muteRow(first.blocks, OTHER, '#other')!;
  const restored = restoreRow(second.blocks, VALUE, first.removed)!;

  // The first row is back with its button; the second is still a done note.
  assert.ok(restored.some((b) => accessoryOf(b)?.value === VALUE && accessoryOf(b)?.action_id === 'dismiss_thread'));
  assert.ok(restored.some((b) => accessoryOf(b)?.value === OTHER && accessoryOf(b)?.action_id === UNDO_ACTION));
});

test('the row returns to its own place, not the end of the message', () => {
  const first = muteRow(blocks(), VALUE, '#chan')!;
  const second = muteRow(first.blocks, OTHER, '#other')!;
  const restored = restoreRow(second.blocks, VALUE, first.removed)!;
  const at = restored.findIndex((b) => accessoryOf(b)?.value === VALUE);
  assert.equal(at, 2, 'the restored row should sit where it was, under the Slack heading');
});

test('a repeated Done click cannot mute the note that replaced the row', () => {
  const { blocks: muted } = muteRow(blocks(), VALUE, '#chan')!;
  assert.equal(muteRow(muted, VALUE, '#chan'), null);
});

test('closing the window removes the button and leaves the note', () => {
  const { blocks: muted } = muteRow(blocks(), VALUE, 'this thread in #chan')!;
  const closed = stripUndoButton(muted, VALUE, 'this thread in #chan')!;

  assert.equal(noteIn(closed), undefined, 'the undo button should be gone');
  const note = closed.find((b) => JSON.stringify(b).includes('Done'))!;
  assert.equal(note.type, 'context');
  assert.match(JSON.stringify(note), /this thread in #chan/);
});

test('closing the window does not change the message length', () => {
  const { blocks: muted } = muteRow(blocks(), VALUE, '#chan')!;
  assert.equal(stripUndoButton(muted, VALUE, '#chan')!.length, muted.length);
});

test('undo after the button is gone finds nothing to restore', () => {
  const { blocks: muted, removed } = muteRow(blocks(), VALUE, '#chan')!;
  const closed = stripUndoButton(muted, VALUE, '#chan')!;
  assert.equal(restoreRow(closed, VALUE, removed), null);
});

test('stripping a message that carries no undo note reports it', () => {
  assert.equal(stripUndoButton(blocks(), VALUE, '#chan'), null);
});

test('restoring with nothing to put back is refused', () => {
  const { blocks: muted } = muteRow(blocks(), VALUE, '#chan')!;
  assert.equal(restoreRow(muted, VALUE, []), null);
});

/** Mirrors the window check in the socket handler and the dashboard route. */
const windowOpen = (expiresAt: string, now: string): boolean => expiresAt > now;

test('the undo window is open before it expires and shut after', () => {
  const expires = '2026-09-11T10:15:00.000Z';
  assert.equal(windowOpen(expires, '2026-09-11T10:14:59.000Z'), true);
  assert.equal(windowOpen(expires, '2026-09-11T10:15:00.000Z'), false);
  assert.equal(windowOpen(expires, '2026-09-11T10:20:00.000Z'), false);
});

test('a fifteen minute window lands fifteen minutes on', () => {
  const at = new Date('2026-09-11T10:00:00.000Z');
  const expires = new Date(at.getTime() + 15 * 60_000).toISOString();
  assert.equal(expires, '2026-09-11T10:15:00.000Z');
});
