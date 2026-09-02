import assert from 'node:assert/strict';
import test from 'node:test';
import { basicAuth } from '../server/auth.js';

function attempt(password: string, header?: string) {
  const middleware = basicAuth(password);
  const res = {
    statusCode: 0, body: '', headers: {} as Record<string, string>,
    set(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; },
    send(b: string) { this.body = b; return this; },
  };
  let passed = false;
  middleware({ headers: header ? { authorization: header } : {} } as never, res as never, () => { passed = true; });
  return { passed, res };
}

const encode = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('the right password gets through', () => {
  assert.equal(attempt('s3cret', encode('admin', 's3cret')).passed, true);
});

test('the wrong password is refused', () => {
  const { passed, res } = attempt('s3cret', encode('admin', 'wrong'));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('no credentials at all prompts for them', () => {
  const { passed, res } = attempt('s3cret');
  assert.equal(passed, false);
  assert.match(res.headers['WWW-Authenticate']!, /Basic realm/);
});

test('the username is ignored — only the password matters', () => {
  assert.equal(attempt('s3cret', encode('anyone', 's3cret')).passed, true);
});

test('a password containing a colon still works', () => {
  assert.equal(attempt('a:b:c', encode('admin', 'a:b:c')).passed, true);
});

test('a shorter or longer guess is rejected without throwing', () => {
  assert.equal(attempt('s3cret', encode('admin', 's3')).passed, false);
  assert.equal(attempt('s3cret', encode('admin', 's3cretlonger')).passed, false);
});

test('a malformed header is refused, not crashed on', () => {
  assert.equal(attempt('s3cret', 'Bearer abc').passed, false);
  assert.equal(attempt('s3cret', 'Basic').passed, false);
});
