import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigSchema } from '../config/schema.js';

// The filtering decisions applied to Slack mentions before they reach a message.
interface M { answered: boolean; answeredByOther: boolean; ccOnly: boolean; key: string }

function applyFilters(mentions: M[], config: ReturnType<typeof ConfigSchema.parse>, dismissed: Set<string>): M[] {
  let kept = mentions;
  if (config.slackIgnoreCcOnly) kept = kept.filter((m) => !m.ccOnly);
  if (config.slackHideWhenCoMentionedReplied) kept = kept.filter((m) => !(!m.answered && m.answeredByOther));
  return kept.filter((m) => !dismissed.has(m.key));
}

const base = ConfigSchema.parse({});
const m = (over: Partial<M> = {}): M => ({ answered: false, answeredByOther: false, ccOnly: false, key: 'C1:1', ...over });

test('Slack cc mentions are kept by default, unlike Teamwork', () => {
  assert.equal(base.slackIgnoreCcOnly, false);
  assert.equal(base.ignoreCcOnlyMentions, true);
  assert.equal(applyFilters([m({ ccOnly: true })], base, new Set()).length, 1);
});

test('a thread a colleague answered is KEPT by default', () => {
  // "Hi @Kiran @Priya can you please raise the PR" — Kiran replying does not
  // discharge Priya. Structurally identical to cases where it does, so never dropped.
  assert.equal(base.slackHideWhenCoMentionedReplied, false);
  assert.equal(applyFilters([m({ answeredByOther: true })], base, new Set()).length, 1);
});

test('opting in to the co-mention rule does drop it', () => {
  const config = ConfigSchema.parse({ slackHideWhenCoMentionedReplied: true });
  assert.equal(applyFilters([m({ answeredByOther: true })], config, new Set()).length, 0);
});

test('but not if I answered it too — that belongs in the replied list', () => {
  const kept = applyFilters([m({ answered: true, answeredByOther: true })], base, new Set());
  assert.equal(kept.length, 1);
});

test('a lone unanswered mention survives every filter', () => {
  assert.equal(applyFilters([m()], base, new Set()).length, 1);
});

test('a muted thread never comes back', () => {
  assert.equal(applyFilters([m({ key: 'C1:99' })], base, new Set(['C1:99'])).length, 0);
});

test('marking a thread done is the reliable way to clear it, whoever replied', () => {
  assert.equal(applyFilters([m({ answeredByOther: true, key: 'C1:7' })], base, new Set(['C1:7'])).length, 0);
});

test('done applies to one thread, not the whole channel', () => {
  // Two threads in the same channel differ by their thread timestamp.
  const sameChannel = [m({ key: 'C1:100' }), m({ key: 'C1:200' })];
  const kept = applyFilters(sameChannel, base, new Set(['C1:100']));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.key, 'C1:200');
});
