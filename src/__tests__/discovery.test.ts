import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverHandles, guessHandles, rankCandidates, slugify } from '../teamwork/discovery.js';

const comment = (body: string) => ({ body, htmlBody: '' });

test('ties a handle to a user id from a real markdown mention', () => {
  // the exact form that confirmed @PriyaS
  const { linked } = discoverHandles([comment('Hi [@PriyaS](/app/people/400001) code review passed')]);
  assert.deepEqual([...linked.get(400001)!.keys()], ['PriyaS']);
});

test('counts repeats so the most-used handle wins', () => {
  const { linked } = discoverHandles([
    comment('[@ArjunR](/app/people/400002) a'),
    comment('[@ArjunR](/app/people/400002) b'),
    comment('[@Arjun](/app/people/400002) c'),
  ]);
  const ranked = [...linked.get(400002)!.entries()].sort((a, b) => b[1] - a[1]);
  assert.equal(ranked[0]![0], 'ArjunR');
  assert.equal(ranked[0]![1], 2);
});

test('keeps different people apart', () => {
  const { linked } = discoverHandles([comment('[@PriyaS](/app/people/400001) and [@PriyaSha](/app/people/400003)')]);
  assert.deepEqual([...linked.get(400001)!.keys()], ['PriyaS']);
  assert.deepEqual([...linked.get(400003)!.keys()], ['PriyaSha']);
});

test('a plain @mention ties to nobody, but is recorded as a real handle', () => {
  const { linked, seen } = discoverHandles([comment('@PriyaS please check')]);
  assert.equal(linked.size, 0);
  assert.equal(seen.get('priyas'), 1);
});

test('a guess that appears in real comments is upgraded to "seen"', () => {
  // @NikhilB appears 115 times in this workspace but never as an id-linked mention
  const evidence = discoverHandles([
    comment('@NikhilB pls check'), comment('cc @NikhilB'), comment('@NikhilB any update'),
  ]);
  const [best] = rankCandidates({ id: 42, firstName: 'Nikhil', lastName: 'Bose' }, evidence);
  assert.equal(best!.handle, 'NikhilB');
  assert.equal(best!.confidence, 'seen');
  assert.equal(best!.count, 3);
});

test('a guess nobody has ever used stays a guess', () => {
  const evidence = discoverHandles([comment('nothing relevant here')]);
  const [best] = rankCandidates({ id: 42, firstName: 'Nikhil', lastName: 'Bose' }, evidence);
  assert.equal(best!.confidence, 'guessed');
  assert.equal(best!.count, 0);
});

test('a confirmed handle outranks a heavily-used guess', () => {
  const evidence = discoverHandles([
    comment('[@TBose](/app/people/42) hi'),
    comment('@NikhilB x'), comment('@NikhilB y'), comment('@NikhilB z'),
  ]);
  const ranked = rankCandidates({ id: 42, firstName: 'Nikhil', lastName: 'Bose' }, evidence);
  assert.equal(ranked[0]!.confidence, 'confirmed');
  assert.equal(ranked[0]!.handle, 'TBose');
});

test('guesses follow the FirstnameLastinitial shape this workspace uses', () => {
  assert.deepEqual(
    guessHandles({ id: 1, firstName: 'Arjun', lastName: 'Rao' }),
    ['ArjunR', 'ArjunRao', 'Arjun'],
  );
});

test('a person with no surname still gets a guess', () => {
  assert.deepEqual(guessHandles({ id: 1, firstName: 'Omar' }), ['Omar']);
});

test('someone with no name at all gets none, rather than a bad guess', () => {
  assert.deepEqual(guessHandles({ id: 1 }), []);
});

test('recipient ids are readable and never collide', () => {
  assert.equal(slugify('Arjun Rao', []), 'arjun-rao');
  assert.equal(slugify('Arjun Rao', ['arjun-rao']), 'arjun-rao-2');
  assert.equal(slugify('Arjun Rao', ['arjun-rao', 'arjun-rao-2']), 'arjun-rao-3');
});

test('punctuation and empty names degrade to something usable', () => {
  assert.equal(slugify('Ravi  Iyer!', []), 'ravi-iyer');
  assert.equal(slugify('', []), 'person');
});

import { matchesQuery } from '../teamwork/discovery.js';

const nikhil = {
  id: 1, name: 'Nikhil Bose', email: 'nikhil@example.com',
  candidates: [{ handle: 'NikhilB', confidence: 'seen' as const, count: 115 }],
};
const omar = {
  id: 2, name: 'Omar Haddad', email: 'omar@example.com',
  candidates: [{ handle: 'OmarH', confidence: 'guessed' as const, count: 0 }],
};

test('typing a handle finds the person — the case that failed', () => {
  assert.equal(matchesQuery(nikhil, '@nik'), true);
  assert.equal(matchesQuery(nikhil, 'nikhilb'), true);
});

test('a leading @ is ignored so both spellings work', () => {
  assert.equal(matchesQuery(nikhil, '@NikhilB'), true);
  assert.equal(matchesQuery(nikhil, 'NikhilB'), true);
});

test('name and email still match', () => {
  assert.equal(matchesQuery(nikhil, 'bose'), true);
  assert.equal(matchesQuery(nikhil, 'nikhil@exam'), true);
});

test('a guessed handle is searchable too', () => {
  assert.equal(matchesQuery(omar, '@omarh'), true);
});

test('matching is case-insensitive and ignores surrounding space', () => {
  assert.equal(matchesQuery(nikhil, '  NIKHIL  '), true);
});

test('an empty query shows everyone', () => {
  assert.equal(matchesQuery(nikhil, ''), true);
  assert.equal(matchesQuery(nikhil, '@'), true);
});

test('a non-match stays out', () => {
  assert.equal(matchesQuery(nikhil, 'dev'), false);
});
