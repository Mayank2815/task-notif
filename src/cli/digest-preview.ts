import 'dotenv/config';
import { DateTime } from 'luxon';
import { getConfig } from '../config/store.js';
import { buildDigest } from '../digest.js';
import { collectWorkspace, makeClient } from '../pipeline.js';

/** Prints the end-of-day digest for every recipient without sending it. */
async function main(): Promise<void> {
  const token = process.env.TEAMWORK_API_TOKEN;
  if (!token) { console.error('TEAMWORK_API_TOKEN missing'); process.exit(1); }

  const config = getConfig();
  const client = makeClient(config, token);
  const ws = await collectWorkspace(client, (m) => console.log(`[scan] ${m}`));
  const since = DateTime.now().setZone(config.timezone).startOf('day').toUTC().toISO() ?? '';
  const activity = await client.activitySince(since);
  console.log(`[scan] ${activity.length} activity entries since ${since}`);

  for (const recipient of config.recipients.filter((r) => r.enabled)) {
    const d = await buildDigest(client, { ...ws, activity }, config, recipient);
    console.log('\n' + '='.repeat(72));
    console.log(`${recipient.label} — ${d.dayLabel} — ${d.total} item(s)`);
    console.log('='.repeat(72));

    console.log(`\n✅ Worked on / updated (${d.updates.length})`);
    for (const u of d.updates) {
      console.log(`  • ${u.taskName}${u.isDone ? '  [dev done]' : ''}${u.isBlocker ? '  [blocker]' : ''}`);
      console.log(`    ${u.project ?? '—'} · ${u.at}`);
      console.log(`    "${u.text}"`);
      if (u.prLinks.length) console.log(`    PR: ${u.prLinks.join(' , ')}`);
      console.log(`    ${u.link}`);
    }

    console.log(`\n🏁 Completed today (${d.completed.length})`);
    for (const c of d.completed) console.log(`  • ${c.taskName} (${c.project ?? '—'})`);

    console.log(`\n🔄 Other changes (${d.statusChanges.length})`);
    for (const s of d.statusChanges.slice(0, 10)) console.log(`  • ${s.description}`);

    console.log(`\n🆕 Landed on you today (${d.newlyAssigned.length})`);
    for (const t of d.newlyAssigned) console.log(`  • ${t.taskName} (${t.project ?? '—'})`);

    console.log(`\n⏳ Asked you, not answered (${d.mentionsOpen.length})`);
    for (const m of d.mentionsOpen) console.log(`  • ${m.taskName} — ${m.author}: "${m.text}"`);

    console.log(`\n💬 Asked you, you replied (${d.mentionsAnswered.length})`);
    for (const m of d.mentionsAnswered) console.log(`  • ${m.taskName} — ${m.author}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
