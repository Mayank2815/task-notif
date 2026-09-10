import assert from 'node:assert/strict';
import test from 'node:test';
import { TeamworkClient } from '../teamwork/client.js';

/** Captures the request instead of sending it. */
async function capture(run: (c: TeamworkClient) => Promise<unknown>) {
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), method: String(init?.method), body: JSON.parse(String(init?.body ?? '{}')) });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ commentId: '9' }) } as unknown as Response;
  }) as typeof fetch;
  try {
    await run(new TeamworkClient({ siteUrl: 'https://tw.example.com', apiToken: 't' }));
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

/**
 * The shape comes from Teamwork's own SDK (twapi-go-sdk, CommentCreateRequest). The
 * first version sent "content-type" and an empty notify — wrong field name, and a value
 * that the SDK documents as "no notifications will be sent".
 */
test('a reply is sent the way Teamwork\'s own SDK sends one', async () => {
  const [req] = await capture((c) => c.postComment(42, '<p>hi</p>', { html: true, notify: [400101, 400104] }));
  assert.equal(req!.method, 'POST');
  assert.equal(req!.url, 'https://tw.example.com/tasks/42/comments.json');
  assert.deepEqual(req!.body, { comment: { body: '<p>hi</p>', contentType: 'HTML', notify: '400101,400104' } });
});

test('a reply that tags nobody leaves notify out, rather than sending an empty one', async () => {
  const [req] = await capture((c) => c.postComment(42, 'done'));
  assert.deepEqual(req!.body, { comment: { body: 'done', contentType: 'TEXT' } });
});

test('moving a due date sends the v3 shape', async () => {
  const [req] = await capture((c) => c.setDueDate(42, '2026-09-15'));
  assert.equal(req!.method, 'PUT');
  assert.equal(req!.url, 'https://tw.example.com/projects/api/v3/tasks/42.json');
  assert.deepEqual(req!.body, { task: { dueAt: '2026-09-15' } });
});

test('completing a task uses the v1 endpoint', async () => {
  const [req] = await capture((c) => c.completeTask(42));
  assert.equal(req!.method, 'PUT');
  assert.equal(req!.url, 'https://tw.example.com/tasks/42/complete.json');
});
