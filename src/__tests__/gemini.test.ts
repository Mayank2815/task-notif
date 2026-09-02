import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiError, collectText } from '../llm/gemini.js';

test('joins text across streamed chunks', () => {
  const stream = [
    { candidates: [{ content: { parts: [{ text: '- Fixed the ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'report bug\n' }] } }] },
    { candidates: [{ content: { parts: [{ text: '- Raised the PR' }] } }] },
  ];
  assert.equal(collectText(stream), '- Fixed the report bug\n- Raised the PR');
});

test('handles a single non-array response too', () => {
  assert.equal(collectText({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), 'OK');
});

test('surfaces a safety block rather than returning empty', () => {
  assert.throws(() => collectText([{ promptFeedback: { blockReason: 'SAFETY' } }]), GeminiError);
});

test('surfaces an API error embedded in the stream', () => {
  assert.throws(() => collectText([{ error: { message: 'quota exceeded' } }]), /quota exceeded/);
});

test('an empty stream yields empty text, not a crash', () => {
  assert.equal(collectText([]), '');
});

test('chunks with no parts are skipped', () => {
  assert.equal(collectText([{ candidates: [{ content: {} }] }, { candidates: [{ content: { parts: [{ text: 'x' }] } }] }]), 'x');
});
