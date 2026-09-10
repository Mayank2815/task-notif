import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pickerView, readSubmission, replyButtonBlock, replyView, tasksInMessage,
  REPLY_INPUT_ACTION, REPLY_INPUT_BLOCK, REPLY_OPEN_ACTION, REPLY_PICK_ACTION,
} from '../slack/reply.js';

const message = (): Record<string, unknown>[] => [
  { type: 'header', text: { type: 'plain_text', text: 'Good morning' } },
  {
    type: 'section', text: { type: 'mrkdwn', text: '`1` *Fix the header*' },
    accessory: { type: 'button', action_id: 'dismiss_task', value: 'shriyam|task:5100001|Fix the header' },
  },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'Web · due today' }] },
  {
    type: 'section', text: { type: 'mrkdwn', text: '`2` *Layout glitch*' },
    accessory: { type: 'button', action_id: 'dismiss_task', value: 'shriyam|task:5100002|Layout glitch' },
  },
  {
    type: 'section', text: { type: 'mrkdwn', text: '*#team_dev*' },
    accessory: { type: 'button', action_id: 'dismiss_thread', value: 'shriyam|C1:1788|#team_dev' },
  },
];

const task = { id: 5100001, name: 'Fix the header' };
const comment = { author: 'Dev Kapoor', at: '2026-09-10T09:00:00Z', body: 'x'.repeat(600) };

test('the tasks are read back out of the message itself', () => {
  assert.deepEqual(tasksInMessage(message()), [
    { id: 5100001, name: 'Fix the header' },
    { id: 5100002, name: 'Layout glitch' },
  ]);
});

test('a Slack thread row is not offered as a Teamwork task', () => {
  assert.ok(!tasksInMessage(message()).some((t) => Number.isNaN(t.id)));
  assert.equal(tasksInMessage(message()).length, 2);
});

test('the same task listed twice is offered once', () => {
  const twice = [...message(), ...message()];
  assert.equal(tasksInMessage(twice).length, 2);
});

test('a message with no tasks offers nothing rather than breaking', () => {
  assert.deepEqual(tasksInMessage([{ type: 'divider' }]), []);
});

test('the reply button is one block, so no task row loses its place', () => {
  const b = replyButtonBlock('shriyam');
  assert.equal(b.type, 'actions');
  assert.equal((b.elements as { action_id: string }[])[0]!.action_id, REPLY_OPEN_ACTION);
});

test('the picker lists the tasks and carries who is replying', () => {
  const v = pickerView('shriyam', tasksInMessage(message()));
  assert.equal(JSON.parse(String(v.private_metadata)).recipientId, 'shriyam');
  const select = ((v.blocks as Record<string, unknown>[])[0]!.accessory) as Record<string, unknown>;
  assert.equal(select.action_id, REPLY_PICK_ACTION);
  assert.equal((select.options as unknown[]).length, 2);
});

test('a long task name is cut to what Slack accepts in an option', () => {
  const v = pickerView('shriyam', [{ id: 1, name: 'n'.repeat(200) }]);
  const select = ((v.blocks as Record<string, unknown>[])[0]!.accessory) as Record<string, unknown>;
  const label = (select.options as { text: { text: string } }[])[0]!.text.text;
  assert.ok(label.length <= 75);
});

test('a nameless task still gets a usable label', () => {
  const v = pickerView('shriyam', [{ id: 42, name: '' }]);
  const select = ((v.blocks as Record<string, unknown>[])[0]!.accessory) as Record<string, unknown>;
  assert.equal((select.options as { text: { text: string } }[])[0]!.text.text, 'Task 42');
});

test('the reply view shows the comment in full, not the reminder snippet', () => {
  const v = replyView('shriyam', task, comment, true);
  const shown = JSON.stringify(v.blocks);
  // The reminder cuts a comment at 180 characters; this one is 600 long.
  assert.ok(shown.includes('x'.repeat(600)), 'the whole comment should be in the modal');
});

test('with a token there is a reply box and a submit button', () => {
  const v = replyView('shriyam', task, comment, true);
  assert.ok(v.submit, 'a person who can post needs a submit button');
  assert.ok(JSON.stringify(v.blocks).includes(REPLY_INPUT_BLOCK));
});

test('without a token there is no box and no submit, and it says why', () => {
  const v = replyView('shriyam', task, comment, false);
  assert.equal(v.submit, undefined, 'nothing to submit without a token');
  assert.ok(!JSON.stringify(v.blocks).includes(REPLY_INPUT_BLOCK));
  assert.match(JSON.stringify(v.blocks), /your own Teamwork token/);
});

test('a task with no comment still opens rather than erroring', () => {
  const v = replyView('shriyam', task, null, true);
  assert.match(JSON.stringify(v.blocks), /No comment found/);
});

test('the submission carries who wrote it and which task', () => {
  const view = {
    private_metadata: JSON.stringify({ recipientId: 'shriyam', taskId: 5100001, taskName: 'Fix the header' }),
    state: { values: { [REPLY_INPUT_BLOCK]: { [REPLY_INPUT_ACTION]: { value: '  on it, will push today  ' } } } },
  };
  assert.deepEqual(readSubmission(view), {
    recipientId: 'shriyam', taskId: 5100001, taskName: 'Fix the header', body: 'on it, will push today',
  });
});

test('an empty reply is not posted', () => {
  const view = {
    private_metadata: JSON.stringify({ recipientId: 'shriyam', taskId: 1 }),
    state: { values: { [REPLY_INPUT_BLOCK]: { [REPLY_INPUT_ACTION]: { value: '   ' } } } },
  };
  assert.equal(readSubmission(view), null);
});

test('a submission that lost its task is refused rather than guessed at', () => {
  const view = {
    private_metadata: JSON.stringify({ recipientId: 'shriyam' }),
    state: { values: { [REPLY_INPUT_BLOCK]: { [REPLY_INPUT_ACTION]: { value: 'hello' } } } },
  };
  assert.equal(readSubmission(view), null);
});

test('corrupt metadata is refused rather than throwing', () => {
  assert.equal(readSubmission({ private_metadata: 'not json', state: { values: {} } }), null);
});
