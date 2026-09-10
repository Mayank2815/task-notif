import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import {
  describeOutcome, loadingView, readSubmission, replyView, taskActions, validateDueDate,
  validateSubmission, whenSaid,
  COMPLETE_ACTION, COMPLETE_BLOCK, COMPLETE_INPUT_ACTION, DUE_ACTION, REPLY_ACTION,
  REPLY_INPUT_ACTION, REPLY_INPUT_BLOCK,
} from '../slack/reply.js';
import { markRowCompleted, markRowMoved, muteRow, restoreRow, routeAction, UNDO_ACTION } from '../slack/socket.js';

const KEY = 'alice|task:5100001|Fix the header';
const task = { id: 5100001, name: 'Fix the header', link: 'https://tw/app/tasks/5100001' };
const now = DateTime.fromISO('2026-09-11T10:00', { zone: 'Asia/Kolkata' });
const elements = (b: Record<string, unknown>) => (b.elements as Record<string, unknown>[]);
const thread = [
  { author: 'Dev Kapoor', avatarUrl: 'https://img/dev.png', at: '2026-09-08T09:00:00Z', body: 'first, some background' },
  { author: 'Kiran menon', avatarUrl: null, at: '2026-09-11T03:00:00Z', body: 'Hi @ArjunR is this merged?\n' + 'x'.repeat(600) },
];

// --- the row -----------------------------------------------------------------------

test('a question row gets Reply and Hide, side by side and one click each', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'reply' });
  assert.deepEqual(elements(b).map((e) => e.action_id), [REPLY_ACTION, 'dismiss_task']);
  assert.ok(elements(b).every((e) => e.type === 'button'));
});

test('an overdue row gets a date, Complete, Comment and Hide', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update', dueDate: '2026-08-01' });
  assert.deepEqual(elements(b).map((e) => e.action_id), [DUE_ACTION, COMPLETE_ACTION, REPLY_ACTION, 'dismiss_task']);
});

test('Complete asks before it acts, since it changes the task for everyone', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update' });
  const complete = elements(b).find((e) => e.action_id === COMPLETE_ACTION)!;
  assert.ok(complete.confirm, 'a one-click Complete with no question would be too easy to hit');
});

test('beside Complete, Done is called Hide so the two cannot be confused', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update' });
  const hide = elements(b).find((e) => e.action_id === 'dismiss_task')!;
  assert.match(JSON.stringify(hide.text), /Hide/);
  assert.ok(!JSON.stringify(b).includes('✅ Done'));
});

test('the date picker is named by its block, since pickers carry no value', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update', dueDate: '2026-08-01' });
  assert.equal(b.block_id, KEY);
  assert.equal(elements(b)[0]!.initial_date, '2026-08-01');
});

test('a malformed due date is not passed to the picker, which Slack would reject', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update', dueDate: '20260801' });
  assert.equal(elements(b)[0]!.initial_date, undefined);
});

test('without a token the row keeps only its one-click Done button', () => {
  const b = taskActions('alice', 5100001, 'Fix the header', { canAct: false });
  assert.deepEqual(elements(b).map((e) => e.action_id), ['dismiss_task']);
  assert.match(JSON.stringify(b), /✅ Done/);
});

test('a very long task name cannot push the key past Slack\'s limits', () => {
  const b = taskActions('alice', 5100001, 'n'.repeat(500), { canAct: true, kind: 'update' });
  assert.ok(String(b.block_id).length <= 255);
  assert.ok(String(elements(b)[1]!.value).startsWith('alice|task:5100001|'));
});

// --- routing ---------------------------------------------------------------------

/**
 * The first version of the reply button shipped broken: routing parsed the dismiss key
 * before deciding what the action was, so an action shaped differently was dropped before
 * its own branch was reached — silently, with no log.
 */
test('Reply routes to replying', () => {
  assert.equal(routeAction({ action_id: REPLY_ACTION, value: KEY })?.kind, 'reply');
});

test('Complete routes to completing', () => {
  assert.equal(routeAction({ action_id: COMPLETE_ACTION, value: KEY })?.kind, 'complete');
});

test('a picked date routes by its block and carries the date', () => {
  assert.deepEqual(routeAction({ action_id: DUE_ACTION, block_id: KEY, selected_date: '2026-09-15' }), {
    kind: 'due', recipientId: 'alice', key: 'task:5100001', label: 'Fix the header', value: KEY, date: '2026-09-15',
  });
});

test('Hide and Undo still route as before', () => {
  assert.equal(routeAction({ action_id: 'dismiss_task', value: KEY })?.kind, 'dismiss');
  assert.equal(routeAction({ action_id: UNDO_ACTION, value: KEY })?.kind, 'undo');
});

test('anything unrecognised or malformed is ignored rather than half-acted on', () => {
  assert.equal(routeAction({ action_id: 'something_else', value: KEY }), null);
  assert.equal(routeAction({ action_id: 'dismiss_task', value: 'alice' }), null);
  assert.equal(routeAction({ action_id: DUE_ACTION, block_id: KEY }), null);
});

// --- what the row turns into ----------------------------------------------------------

const rowWithControls = (): Record<string, unknown>[] => [
  { type: 'section', text: { type: 'mrkdwn', text: '`1`  🔴 40d   *Fix the header*' } },
  taskActions('alice', 5100001, 'Fix the header', { canAct: true, kind: 'update', dueDate: '2026-08-01' }),
  { type: 'section', text: { type: 'mrkdwn', text: '`2`  🔴 3d   *Layout glitch*' } },
  taskActions('alice', 5100002, 'Layout glitch', { canAct: true, kind: 'update', dueDate: '2026-09-08' }),
];

test('a date moved to today is noted on the row and the controls stay', () => {
  const out = markRowMoved(rowWithControls(), KEY, '2026-09-11', '2026-09-11')!;
  assert.match(JSON.stringify(out[0]), /moved to Fri 11 Sep/);
  assert.equal(elements(out[1]!)[0]!.initial_date, '2026-09-11');
  assert.equal(out.length, 4, 'nothing is removed');
});

test('moving it later takes the row out; the rest of the message is untouched', () => {
  const out = markRowMoved(rowWithControls(), KEY, '2026-09-18', '2026-09-11')!;
  assert.equal(out.length, 3);
  assert.match(JSON.stringify(out[0]), /off the overdue list/);
  assert.equal(elements(out[2]!).length, 4);
});

test('a completed task leaves the message with a line saying so', () => {
  const out = markRowCompleted(rowWithControls(), KEY, 'Fix the header')!;
  assert.equal(out.length, 3);
  assert.match(JSON.stringify(out[0]), /Completed in Teamwork — Fix the header/);
  assert.equal(elements(out[2]!).length, 4, 'the other task keeps its controls');
});

test('Hide still works when the controls sit in an actions block, and Undo restores them', () => {
  const original = rowWithControls();
  const muted = muteRow(original, KEY, 'Fix the header')!;
  assert.equal(muted.removed.length, 2);
  assert.deepEqual(restoreRow(muted.blocks, KEY, muted.removed), original);
});

test('a date before today is refused, and a proper one accepted', () => {
  assert.match(validateDueDate('2026-09-10', '2026-09-11')!, /today or a later date/);
  assert.equal(validateDueDate('2026-09-11', '2026-09-11'), null);
  assert.match(validateDueDate('15/09/2026', '2026-09-11')!, /not a date/);
});

// --- the modal ---------------------------------------------------------------------

const shown = (canPost = true, opts = {}) => JSON.stringify(replyView('alice', task, thread, canPost, { now, ...opts }).blocks);

test('each comment has its own byline, quote bar and rule', () => {
  const blocks = replyView('alice', task, thread, true, { now }).blocks as Record<string, unknown>[];
  assert.equal(blocks.filter((b) => b.type === 'divider').length, thread.length + 1);
  assert.ok(blocks.some((b) => String((b.text as { text?: string })?.text ?? '').startsWith('>')));
});

test('an author with a photo shows it, one without still gets a name', () => {
  assert.match(shown(), /https:\/\/img\/dev\.png/);
  assert.match(shown(), /Kiran menon/);
});

test('the thread reads oldest first, newest beside the reply box', () => {
  assert.ok(shown().indexOf('first, some background') < shown().indexOf('is this merged'));
  assert.match(shown(), /🆕 latest/);
});

test('a comment naming you is marked', () => {
  assert.match(shown(true, { handles: ['ArjunR'] }), /🔔 mentions you/);
  assert.ok(!shown(true, { handles: ['SomeoneElse'] }).includes('mentions you'));
});

test('times read the way people say them', () => {
  assert.equal(whenSaid('2026-09-11T03:00:00Z', now), 'today 08:30');
  assert.equal(whenSaid('2026-09-10T03:00:00Z', now), 'yesterday 08:30');
  assert.equal(whenSaid('2026-09-08T09:00:00Z', now), '3 days ago');
  assert.equal(whenSaid('2026-08-01T09:00:00Z', now), '1 Aug');
});

test('the comment is shown in full, not the reminder\'s snippet', () => {
  assert.ok(shown().includes('x'.repeat(600)));
});

test('text that looks like markup is shown, not interpreted', () => {
  const v = JSON.stringify(replyView('alice', task, [{ author: 'A', at: '', body: 'a <b> & c' }], true, { now }).blocks);
  assert.match(v, /a &lt;b&gt; &amp; c/);
});

test('when comments were left out it says how many, with a way to see them all', () => {
  assert.match(shown(true, { total: 28 }), /Last 2 of 28 comments/);
  assert.match(shown(true, { total: 28 }), /see all in Teamwork/);
  assert.ok(!shown().includes('Last 2 of'));
});

test('the title links to the task', () => {
  assert.match(shown(), /<https:\/\/tw\/app\/tasks\/5100001\|Fix the header>/);
});

test('with a token there is a reply box and a complete box, and no date — that lives on the row', () => {
  assert.ok(shown().includes(REPLY_INPUT_BLOCK));
  assert.ok(shown().includes(COMPLETE_BLOCK));
  assert.ok(!shown().includes('datepicker'));
});

test('without a token there is nothing to submit, and it says why', () => {
  const v = replyView('alice', task, thread, false, { now });
  assert.equal(v.submit, undefined);
  assert.match(JSON.stringify(v.blocks), /your own Teamwork token/);
});

test('an empty thread still opens', () => {
  assert.match(JSON.stringify(replyView('alice', task, [], true, { now }).blocks), /No comments on this task yet/);
});

test('the loading view cannot be submitted early', () => {
  assert.equal(loadingView('Fix the header').submit, undefined);
});

// --- saving ------------------------------------------------------------------------

const richOf = (text: string) => (text
  ? { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }
  : { type: 'rich_text', elements: [] });

const submitted = (body: string, complete: boolean) => ({
  private_metadata: JSON.stringify({ recipientId: 'alice', taskId: 5100001, taskName: 'Fix the header' }),
  state: { values: {
    [REPLY_INPUT_BLOCK]: { [REPLY_INPUT_ACTION]: { rich_text_value: richOf(body) } },
    [COMPLETE_BLOCK]: { [COMPLETE_INPUT_ACTION]: { selected_options: complete ? [{ value: 'complete' }] : [] } },
  } },
});

test('the row a modal was opened from survives the round trip', () => {
  const view = replyView('alice', task, thread, true, { now, origin: { msgKey: 'D1:1788.1', rowKey: KEY } });
  const back = readSubmission({ ...view, state: { values: {
    [REPLY_INPUT_BLOCK]: { [REPLY_INPUT_ACTION]: { rich_text_value: { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'ok' }] }] } } },
  } } })!;
  assert.deepEqual(back.origin, { msgKey: 'D1:1788.1', rowKey: KEY });
  assert.ok(String(view.private_metadata).length < 3000, 'Slack caps private_metadata at 3000');
});

test('a submission carries the reply and whether to complete', () => {
  const sub = readSubmission(submitted('on it', true))!;
  assert.equal(sub.text, 'on it');
  assert.equal(sub.complete, true);
  assert.equal(sub.taskId, 5100001);
  assert.ok(sub.rich);
});

test('a tag on its own counts as a reply', () => {
  const view = submitted('', false);
  (view.state.values[REPLY_INPUT_BLOCK][REPLY_INPUT_ACTION] as { rich_text_value: unknown }).rich_text_value =
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U1' }] }] };
  const sub = readSubmission(view)!;
  assert.deepEqual(sub.mentions, ['U1']);
  assert.equal(validateSubmission(sub), null);
});

test('a reply alone, or completing alone, is enough', () => {
  assert.equal(validateSubmission(readSubmission(submitted('on it', false))!), null);
  assert.equal(validateSubmission(readSubmission(submitted('', true))!), null);
});

test('saving with nothing in it keeps the modal open with a reason', () => {
  const errors = validateSubmission(readSubmission(submitted('', false))!);
  assert.ok(errors?.[REPLY_INPUT_BLOCK]);
});

test('the reply box is Slack\'s rich composer, so typing @ brings up people', () => {
  const blocks = replyView('alice', task, thread, true, { now }).blocks as Record<string, unknown>[];
  const input = blocks.find((b) => b.block_id === REPLY_INPUT_BLOCK)!;
  assert.equal((input.element as { type: string }).type, 'rich_text_input');
});

test('corrupt metadata is refused rather than throwing', () => {
  assert.equal(readSubmission({ private_metadata: 'not json', state: { values: {} } }), null);
});

test('the confirmation says what happened, and what did not', () => {
  assert.equal(describeOutcome('Fix the header', ['reply posted', 'marked complete'], null),
    '✅ *Fix the header* — reply posted · marked complete');
  assert.match(describeOutcome('Fix the header', ['reply posted'], { step: 'mark it complete', reason: 'Teamwork 403' }),
    /Could not mark it complete.*Teamwork 403.*Already done: reply posted/);
});

// --- fitting a fixed-width modal --------------------------------------------------------

import { shortLink } from '../slack/reply.js';

const AWS = 'https://us-east-2.console.aws.amazon.com/codesuite/codecommit/repositories/expertly.server/pull-requests/47210/details?region=us-east-2';

test('a long link reads as where it goes, not its whole address', () => {
  assert.equal(shortLink(AWS), 'amazon.com › pull-requests/47210');
  assert.equal(shortLink('https://github.com/a/b/pull/12'), 'github.com › pull/12');
  assert.equal(shortLink('https://www.figma.com/'), 'figma.com');
});

test('the shortened link still opens the full address', () => {
  const v = JSON.stringify(replyView('alice', task, [{ author: 'A', at: '', body: `PR : ${AWS}\nplease review` }], true, { now }).blocks);
  assert.ok(v.includes(`<${AWS}|🔗 amazon.com › pull-requests/47210>`));
  assert.match(v, /please review/);
});

test('a full stop after a link stays outside it', () => {
  const v = JSON.stringify(replyView('alice', task, [{ author: 'A', at: '', body: 'see https://github.com/a/b/pull/12.' }], true, { now }).blocks);
  assert.ok(v.includes('<https://github.com/a/b/pull/12|🔗 github.com › pull/12>.'));
});

test('text around a link is still escaped', () => {
  const v = JSON.stringify(replyView('alice', task, [{ author: 'A', at: '', body: '<b> https://github.com/a/b' }], true, { now }).blocks);
  assert.match(v, /&lt;b&gt;/);
});

test('the reply box starts tall and has the cursor in it', () => {
  const blocks = replyView('alice', task, thread, true, { now }).blocks as Record<string, unknown>[];
  const el = blocks.find((b) => b.block_id === REPLY_INPUT_BLOCK)!.element as Record<string, unknown>;
  assert.equal(el.min_lines, 8);
  assert.equal(el.focus_on_load, true);
});
