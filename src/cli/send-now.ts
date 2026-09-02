import 'dotenv/config';
import { getConfig } from '../config/store.js';
import { runAndDeliver } from '../deliver.js';

/** Runs the scan and delivers immediately, outside the schedule. */
async function main(): Promise<void> {
  const teamwork = process.env.TEAMWORK_API_TOKEN;
  const slack = process.env.SLACK_BOT_TOKEN;
  if (!teamwork || !slack) {
    console.error('Both TEAMWORK_API_TOKEN and SLACK_BOT_TOKEN must be set in .env');
    process.exit(1);
  }

  const job = process.argv[2] === 'digest' ? 'digest' : 'reminder';
  console.log(`[send] job=${job}`);
  const outcome = await runAndDeliver(getConfig(), teamwork, slack, job, 'manual', (m) => console.log(`[send] ${m}`));
  console.log('\n--- result ---');
  for (const r of outcome.perRecipient) {
    console.log(`${r.id}: matched=${r.matched} delivered=${r.delivered}${r.error ? ` error=${r.error}` : ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
