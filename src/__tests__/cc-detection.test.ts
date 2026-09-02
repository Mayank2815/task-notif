import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIdentity, mentionRole } from '../teamwork/identity.js';

const identity = buildIdentity(
  { id: 400001, firstName: 'Priya', lastName: 'Pandey', email: 'mayankmp@example.com' },
  ['PriyaS'],
);
const role = (body: string) => mentionRole({ body, htmlBody: '' }, identity);

// Every string below is real comment text from the workspace.

test('cc after another addressee is a courtesy copy', () => {
  // task 27421297 — the one flagged as clutter
  assert.equal(role("Hi @DevK cc @PriyaS @NikhilB I've reviewed the story. Review comments are below."), 'cc');
});

test('trailing cc list is a courtesy copy', () => {
  assert.equal(role('The changes have been verified and are working as expected on UAT environment cc @MaxW @PriyaS @LeoF'), 'cc');
});

test('a direct ask is directed', () => {
  assert.equal(role('@PriyaS Pls check cc @JoseP'), 'directed');
  assert.equal(role('@PriyaS @KiranD can we check this pls?'), 'directed');
});

test('markdown mention outside the cc list is directed', () => {
  assert.equal(
    role('Hi [@PriyaS](/app/people/400001) (cc: [@RaviI](/app/people/303394)) Code Review: Passed'),
    'directed',
  );
});

test('markdown mention inside the cc list is a copy', () => {
  assert.equal(
    role('Hi [@DevK](/app/people/290759) (cc: [@PriyaS](/app/people/400001)) Code Review: Passed'),
    'cc',
  );
});

test('being named mid-sentence is directed, not cc', () => {
  assert.equal(role('@ElsaK Pls verify this issue once and then let @PriyaS @ArjunR know if its replicable. cc @JoseP'), 'directed');
});

test('cc variants are all recognised', () => {
  assert.equal(role('Updated the doc. FYI @PriyaS'), 'cc');
  assert.equal(role('Shipped it, cc: @PriyaS'), 'cc');
  assert.equal(role('Done — copying @NikhilB and @PriyaS'), 'cc');
});

test('a cc list ends when prose resumes', () => {
  // "@PriyaS" here follows the sentence, not the cc run, so it is a real address
  assert.equal(role('Done cc @NikhilB — separately @PriyaS can you confirm the mapping?'), 'directed');
});

test('a bare "cc" with no handles opens nothing', () => {
  assert.equal(role('I will cc the vendor later. @PriyaS please review'), 'directed');
});

test('other people\'s cc lists do not affect me', () => {
  assert.equal(role('@PriyaS please review cc @NikhilB @DevK'), 'directed');
});

test('not mentioned at all', () => {
  assert.equal(role('@PriyaSha pls check cc @ArjunR'), 'none');
});
