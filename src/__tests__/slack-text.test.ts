import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanText } from '../slack/mentions.js';

const names = new Map([
  ['U0CCCCCCCC3', 'Rahul Gupta'],
  ['U0AAAAAAAA1', 'Priya Sharma'],
  ['U0DDDDDDDD4', 'Vinod Kumar'],
]);

test('resolves bare user ids to display names', () => {
  // real text from the workspace
  const raw = 'hi <@U0CCCCCCCC3> <@U0AAAAAAAA1> please check this BUG cc <@U0DDDDDDDD4>';
  assert.equal(cleanText(raw, names), 'hi @Rahul Gupta @Priya Sharma please check this BUG cc @Vinod Kumar');
});

test('keeps the inline name when Slack already supplies one', () => {
  assert.equal(cleanText('ping <@U0000000|priya> here', names), 'ping @priya here');
});

test('leaves an unknown id legible rather than blank', () => {
  assert.equal(cleanText('hi <@UNOTINLIST>', names), 'hi @UNOTINLIST');
});

test('renders channel references by name', () => {
  assert.equal(cleanText('see <#C123|team_frontend_dev>', names), 'see #team_frontend_dev');
});

test('renders user groups and broadcasts readably', () => {
  assert.equal(cleanText('<!subteam^S123|@qa-team> please look', names), '@qa-team please look');
  assert.equal(cleanText('<!here> standup now', names), '@here standup now');
  assert.equal(cleanText('<!channel> deploy done', names), '@channel deploy done');
});

test('unwraps links, keeping the label when there is one', () => {
  assert.equal(
    cleanText('Checked <https://projects.example.com/app/tasks/27461140|task 27461140>', names),
    'Checked task 27461140',
  );
  assert.equal(cleanText('see <https://example.com/x>', names), 'see https://example.com/x');
});

test('collapses whitespace so multi-line messages stay on one line', () => {
  assert.equal(cleanText('line one\n\n   line two', names), 'line one line two');
});

test('works with no directory loaded, falling back to ids', () => {
  assert.equal(cleanText('hi <@U0AAAAAAAA1>'), 'hi @U0AAAAAAAA1');
});

import { isCcOnly } from '../slack/mentions.js';

const ME = 'U0AAAAAAAA1';

test('a trailing CC in Slack is a courtesy copy', () => {
  // real message from #team_frontend_dev
  assert.equal(isCcOnly('Sure will check them, Angular migration is a big jump from 15 to 19 CC <@U0AAAAAAAA1>', ME), true);
});

test('being asked directly is not a cc, even with a cc list present', () => {
  assert.equal(isCcOnly('hi <@U0CCCCCCCC3> <@U0AAAAAAAA1> please check this BUG cc <@U0DDDDDDDD4>', ME), false);
});

test('a message with no cc marker is never cc-only', () => {
  assert.equal(isCcOnly('<@U0AAAAAAAA1> call once available', ME), false);
});

test('someone else being cc-d does not affect me', () => {
  assert.equal(isCcOnly('<@U0AAAAAAAA1> please review cc <@U0DDDDDDDD4>', ME), false);
});

// Dismissal keys must be stable across runs, since they are what the Mute button stores.
test('a thread key is channel plus thread root, not the message ts', () => {
  const channel = 'C010ZUN6VS5';
  const threadRoot = '1788330500.076199';
  const replyTs = '1788333285.981399';
  // Two different replies in the same thread must produce the same key.
  assert.equal(`${channel}:${threadRoot}`, `${channel}:${threadRoot}`);
  assert.notEqual(`${channel}:${threadRoot}`, `${channel}:${replyTs}`);
});
