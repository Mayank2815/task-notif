import 'dotenv/config';
import { TeamworkClient, TeamworkError } from '../teamwork/client.js';

/** Discovery script: confirms which endpoints exist on this site and dumps real field shapes. */
async function main(): Promise<void> {
  const siteUrl = process.env.TEAMWORK_SITE_URL;
  const apiToken = process.env.TEAMWORK_API_TOKEN;
  if (!siteUrl || !apiToken) {
    console.error('Set TEAMWORK_SITE_URL and TEAMWORK_API_TOKEN in .env first.');
    process.exit(1);
  }

  const client = new TeamworkClient({ siteUrl, apiToken });

  const me = await tryCall('me', () => client.request<Record<string, unknown>>('/projects/api/v3/me.json'));
  const myId = Number((me?.person as Record<string, unknown> | undefined)?.id ?? 0);
  console.log(`\n=== identity ===\nuserId=${myId}`);
  console.log(JSON.stringify((me?.person as Record<string, unknown>) ?? {}, null, 2).slice(0, 800));

  const projects = await tryCall('projects', () =>
    client.request<Record<string, unknown>>('/projects/api/v3/projects.json', { pageSize: 5 }),
  );
  console.log(`\n=== projects ===\ncount(first page)=${(projects?.projects as unknown[] | undefined)?.length ?? 0}`);
  console.log('meta:', JSON.stringify(projects?.meta ?? {}));

  const tasks = await tryCall('tasks', () =>
    client.request<Record<string, unknown>>('/projects/api/v3/tasks.json', {
      pageSize: 3,
      include: 'users,projects',
      includeCompletedTasks: false,
    }),
  );
  const taskRows = (tasks?.tasks as Record<string, unknown>[] | undefined) ?? [];
  console.log(`\n=== tasks ===\nkeys: ${Object.keys(taskRows[0] ?? {}).join(', ')}`);
  console.log('sample:', JSON.stringify(taskRows[0] ?? {}, null, 2).slice(0, 1500));
  console.log('meta:', JSON.stringify(tasks?.meta ?? {}));

  // A workspace-wide comment sweep would let us find mentions without one call per task.
  const globalComments = await tryCall('comments (global v3)', () =>
    client.request<Record<string, unknown>>('/projects/api/v3/comments.json', { pageSize: 3 }),
  );
  if (globalComments) {
    const rows = (globalComments.comments as Record<string, unknown>[] | undefined) ?? [];
    console.log(`\n=== global comments ===\nkeys: ${Object.keys(rows[0] ?? {}).join(', ')}`);
    console.log('sample:', JSON.stringify(rows[0] ?? {}, null, 2).slice(0, 1500));
  }

  const sampleTaskId = Number(taskRows[0]?.id ?? 0);
  if (sampleTaskId) {
    const taskComments = await tryCall(`comments for task ${sampleTaskId}`, () =>
      client.request<Record<string, unknown>>(`/projects/api/v3/tasks/${sampleTaskId}/comments.json`, { pageSize: 3 }),
    );
    const rows = (taskComments?.comments as Record<string, unknown>[] | undefined) ?? [];
    console.log(`\n=== task comments ===\nkeys: ${Object.keys(rows[0] ?? {}).join(', ')}`);
    console.log('sample:', JSON.stringify(rows[0] ?? {}, null, 2).slice(0, 1500));
  }

  console.log('\nProbe complete.');
}

async function tryCall<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const out = await fn();
    console.log(`[ok]   ${label}`);
    return out;
  } catch (err) {
    const e = err as TeamworkError;
    console.log(`[fail] ${label} — ${e.status ?? ''} ${e.message}`);
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
