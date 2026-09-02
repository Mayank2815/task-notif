import 'dotenv/config';
import { getConfig } from '../config/store.js';
import { runScan } from '../pipeline.js';

/** Prints exactly what the next reminder would contain, for every recipient, without sending anything. */
async function main(): Promise<void> {
  const apiToken = process.env.TEAMWORK_API_TOKEN;
  if (!apiToken) {
    console.error('TEAMWORK_API_TOKEN missing from .env');
    process.exit(1);
  }

  const config = getConfig();
  const { results, stats } = await runScan(config, apiToken, (m) => console.log(`[scan] ${m}`));

  for (const r of results) {
    console.log('\n' + '='.repeat(72));
    console.log(`${r.recipient.label || r.identity.displayName} — ${r.total} task${r.total === 1 ? '' : 's'} need attention`);
    console.log('='.repeat(72));

    for (const group of r.groups) {
      console.log(`\n### ${group.label} (${group.items.length})`);
      for (const { task, match, assigneeNames } of group.items) {
        console.log(`\n  • ${task.name}`);
        console.log(`    project:  ${task.projectName ?? '—'}`);
        console.log(`    assignee: ${assigneeNames.length ? assigneeNames.join(', ') : 'unassigned'}`);
        console.log(`    due:      ${task.dueDate ?? '—'}`);
        console.log(`    why:      ${match.detail}`);
        console.log(`    link:     ${match.link}`);
      }
    }
    if (r.total === 0) console.log('\n  (nothing pending)');
  }

  console.log(`\n--- ${stats.commentsSwept} comments swept, ${stats.tasksIndexed} tasks indexed, ${(stats.durationMs / 1000).toFixed(1)}s ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
