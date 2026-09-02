import assert from 'node:assert/strict';
import test from 'node:test';
import { userTokenFor } from '../slack/mentions.js';

test('reads a per-recipient token from the environment', () => {
  process.env.SLACK_USER_TOKEN_TESTPERSON = 'xoxp-abc';
  assert.equal(userTokenFor('testperson'), 'xoxp-abc');
  assert.equal(userTokenFor('TestPerson'), 'xoxp-abc');
  delete process.env.SLACK_USER_TOKEN_TESTPERSON;
});

test('normalises punctuation in a recipient id to the env-var form', () => {
  process.env.SLACK_USER_TOKEN_TWO_PART = 'xoxp-def';
  assert.equal(userTokenFor('two-part'), 'xoxp-def');
  assert.equal(userTokenFor('two.part'), 'xoxp-def');
  delete process.env.SLACK_USER_TOKEN_TWO_PART;
});

test('a missing or blank token reads as absent, so the Slack section is skipped', () => {
  assert.equal(userTokenFor('nobody-home'), null);
  process.env.SLACK_USER_TOKEN_BLANKY = '   ';
  assert.equal(userTokenFor('blanky'), null);
  delete process.env.SLACK_USER_TOKEN_BLANKY;
});
