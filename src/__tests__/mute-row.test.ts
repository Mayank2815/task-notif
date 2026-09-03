import assert from 'node:assert/strict';
import test from 'node:test';
import { muteRow } from '../slack/socket.js';

const VALUE = 'alice|G01A5LG5ZPX:1788242536.831209|#team_workflow_dev';

const blocks = (): Record<string, unknown>[] => [
  { type: 'header', text: { type: 'plain_text', text: '📋 24 items need your attention' } },
  { type: 'divider' },
  { type: 'section', text: { type: 'mrkdwn', text: '*💬 Slack — still unanswered* · 5' } },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*#team_workflow_dev*\n_@Vinod @Nikhil Bose_' },
    accessory: { type: 'button', action_id: 'dismiss_thread', value: VALUE },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Dev Kapoor · 2026-09-01' }] },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*#team_frontend_dev*\n_Sure will check them_' },
    accessory: { type: 'button', action_id: 'dismiss_thread', value: 'alice|G011LCJNCHZ:1|#team_frontend_dev' },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Arjun Rao · 2026-09-02' }] },
];

test('the finished row loses its button', () => {
  const out = muteRow(blocks(), VALUE, '#team_workflow_dev')!;
  assert.ok(out.every((b) => (b.accessory as { value?: string } | undefined)?.value !== VALUE));
});

test('it is replaced by a done note, not deleted silently', () => {
  const out = muteRow(blocks(), VALUE, 'this thread in #team_workflow_dev')!;
  const note = out.find((b) => JSON.stringify(b).includes('Done'));
  assert.ok(note);
  assert.equal(note!.type, 'context');
});

test('the row metadata line goes with it — two blocks become one', () => {
  const before = blocks();
  const out = muteRow(before, VALUE, '#chan')!;
  assert.equal(out.length, before.length - 1);
  assert.ok(!JSON.stringify(out).includes('Dev Kapoor'));
});

test('other rows keep their buttons', () => {
  const out = muteRow(blocks(), VALUE, '#chan')!;
  const remaining = out.filter((b) => (b.accessory as { action_id?: string } | undefined)?.action_id === 'dismiss_thread');
  assert.equal(remaining.length, 1);
});

test('the section count is decremented so the header stays honest', () => {
  const out = muteRow(blocks(), VALUE, '#chan')!;
  const header = out.find((b) => String((b.text as { text?: string } | undefined)?.text ?? '').includes('Slack — still unanswered'));
  assert.match(String((header!.text as { text: string }).text), /· 4$/);
});

test('an unknown value changes nothing and reports it', () => {
  assert.equal(muteRow(blocks(), 'not-a-real-value', '#chan'), null);
});

test('the note names the thread, not just the channel', () => {
  const out = muteRow(blocks(), VALUE, 'this thread in #team_workflow_dev')!;
  const note = out.find((b) => JSON.stringify(b).includes('Done'))!;
  assert.match(JSON.stringify(note), /this thread in/);
});

test('a row with no trailing context block still resolves cleanly', () => {
  const minimal: Record<string, unknown>[] = [
    { type: 'section', text: { type: 'mrkdwn', text: 'x' }, accessory: { value: VALUE } },
  ];
  const out = muteRow(minimal, VALUE, '#chan')!;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'context');
});
