import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanTaskName, snippet, stripMarkdown } from '../teamwork/identity.js';

test('a markdown mention link becomes a plain handle', () => {
  // this leaked into a real reminder
  assert.equal(stripMarkdown('Hi [@PriyaS](/app/people/400001) code review passed'), 'Hi @PriyaS code review passed');
});

test('bold markers are removed, the words kept', () => {
  assert.equal(stripMarkdown('**Code Review: Passed** — all three diffs'), 'Code Review: Passed — all three diffs');
});

test('a fenced code block collapses instead of filling the message', () => {
  const npmNoise = 'see ```npm notice name: @acme/components\nversion: 1.4.1\nsize: 5.1 MB``` for details';
  assert.equal(stripMarkdown(npmNoise), 'see [code] for details');
});

test('inline code keeps its text', () => {
  assert.equal(stripMarkdown('run `npm ci` first'), 'run npm ci first');
});

test('bullets and headings flatten to one readable line', () => {
  assert.equal(stripMarkdown('## Notes\n- one\n- two'), 'Notes • one • two');
});

test('the trailing asterisk Teamwork adds to titles is dropped', () => {
  assert.equal(cleanTaskName('UI Issue *'), 'UI Issue');
  assert.equal(cleanTaskName('Phase 4 (Angular 18 to 19) *'), 'Phase 4 (Angular 18 to 19)');
});

test('an asterisk inside a title is left alone', () => {
  assert.equal(cleanTaskName('Support 2 * 3 multiplication'), 'Support 2 * 3 multiplication');
});

test('snippets are cleaned as well as truncated', () => {
  const out = snippet('Hi [@PriyaS](/app/people/1) **please** check', 200);
  assert.equal(out, 'Hi @PriyaS please check');
});
