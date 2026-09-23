import { hoursAndMinutes, type Digest } from '../digest.js';
import { cleanTaskName } from '../teamwork/identity.js';
import { renderSlackRows, sectionHeading, summarySections, type RenderedMessage } from './message.js';
import { paginate } from './paginate.js';


function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url: string, label: string): string {
  return `<${url}|${esc(label)}>`;
}

function time(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
  } catch {
    return '';
  }
}

/**
 * The end-of-day recap: what you did, what still wants an answer, what landed on you.
 * `kind` only changes the wording at the top — a week reads from the same digest as a
 * day, because the window is the only thing that differs.
 */
export function renderDigest(
  digest: Digest, timezone: string, note?: string, kind: 'day' | 'standup' | 'week' = 'day',
): RenderedMessage {
  const name = digest.recipient.label || digest.identity.displayName;
  const isStandup = kind === 'standup' || (kind === 'day' && digest.dayOffset > 0);

  if (digest.total === 0) {
    const quiet = kind === 'week' ? 'Nothing logged this week' : 'Nothing logged today';
    return {
      text: `No Teamwork activity logged — ${digest.dayLabel}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `🌙 ${quiet}`, emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(digest.dayLabel)} · no comments or updates recorded in Teamwork` }] },
      ],
    };
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: kind === 'week'
          ? `📅 Your week — ${digest.dayLabel}`
          : isStandup ? `🗣️ Yesterday — ${digest.dayLabel}` : `🌙 Your day — ${digest.dayLabel}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${kind === 'week' ? 'The week in review' : isStandup ? 'For today\'s stand-up' : 'Today so far'} · ${esc(name)}${note ? `  ·  ${esc(note)}` : ''}`,
      }],
    },
  ];

  const section = (text: string) => blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  // A list of any length, as as many sections as it takes to stay inside Slack's
  // 3,000-character limit per section. It used to stop at twelve items.
  const lines = (items: string[]) => summarySections(items.join('\n'));

  if (digest.summary) {
    blocks.push({ type: 'divider' });
    // Already escaped by its builder, and carries links that esc() would break.
    blocks.push(...summarySections(digest.summary, `*🗒️ ${kind === 'week' ? 'The week in short' : "For tomorrow's stand-up"}*`));
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_assembled from the items below_' }] });
  }

  if (digest.updates.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`✅ Worked on / updated · ${digest.updates.length}`));
    for (const u of digest.updates) {
      const tags = [u.isDone ? '`dev done`' : null, u.isBlocker ? '`blocker`' : null].filter(Boolean).join(' ');
      const prs = u.prLinks.length ? `\n🔗 ${u.prLinks.map((p, i) => link(p, u.prLinks.length > 1 ? `PR ${i + 1}` : 'PR')).join('  ')}` : '';
      section(`*${link(u.link, cleanTaskName(u.taskName))}*${tags ? ` ${tags}` : ''}\n>${esc(u.text)}${prs}`);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${u.project ? `${esc(u.project)}  ·  ` : ''}${time(u.at, timezone)}` }],
      });
    }
  }

  // Not called "time": that name is the clock-time formatter used throughout this function.
  const logged = digest.timeLogged ?? [];
  if (logged.length > 0) {
    const total = logged.reduce((n, t) => n + t.minutes, 0);
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`⏱️ Time logged · ${hoursAndMinutes(total)} on ${logged.length} task${logged.length === 1 ? '' : 's'}`));
    blocks.push(...lines(logged.map((t) =>
      `• ${link(t.link, cleanTaskName(t.taskName))} — ${hoursAndMinutes(t.minutes)}${t.project ? ` _(${esc(t.project)})_` : ''}`)));
  }

  if (digest.completed.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🏁 Completed ${kind === 'week' ? 'this week' : 'today'} · ${digest.completed.length}`));
    blocks.push(...lines(digest.completed.map((c) => `• ${c.link ? link(c.link, cleanTaskName(c.taskName)) : esc(cleanTaskName(c.taskName))}${c.project ? ` _(${esc(c.project)})_` : ''}`)));
  }

  if (digest.statusChanges.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🔄 Other changes you made · ${digest.statusChanges.length}`));
    blocks.push(...lines(digest.statusChanges.map((s) => `• ${esc(s.description)} _(${time(s.at, timezone)})_`)));
  }

  if (digest.newlyAssigned.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🆕 Landed on you ${kind === 'week' ? 'this week' : 'today'} · ${digest.newlyAssigned.length}`));
    blocks.push(...lines(digest.newlyAssigned.map((t) => `• ${link(t.link, cleanTaskName(t.taskName))}${t.project ? ` _(${esc(t.project)})_` : ''}`)));
  }

  if (digest.mentionsOpen.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`⏳ Asked you — not answered yet · ${digest.mentionsOpen.length}`));
    for (const m of digest.mentionsOpen) {
      section(`*${link(m.link, cleanTaskName(m.taskName))}*\n>${esc(m.text)}`);
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(m.author)}  ·  ${time(m.at, timezone)}` }] });
    }
  }

  if (digest.meetings.length > 0) {
    blocks.push(sectionHeading(`📞 Calls & meetings · ${digest.meetings.length}`));
    for (const m of digest.meetings) {
      section(`*${link(m.permalink, m.channel)}* — ${esc(m.author)}\n>${esc(truncate(m.text, 160))}`);
    }
  }

  if (digest.slackActivity.length > 0) {
    blocks.push(sectionHeading(`🗨️ Where you talked · ${digest.slackActivity.length}`));
    // 100+ individual messages is noise; the conversation and a count is the useful part.
    blocks.push(...lines(digest.slackActivity.map((a) =>
      `• ${link(a.permalink, a.channel)} — ${a.messages} message${a.messages === 1 ? '' : 's'}`)));
  }

  if (digest.slackAwaiting.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`💬 Slack — awaiting your reply · ${digest.slackAwaiting.length}`));
    blocks.push(...renderSlackRows(digest.slackAwaiting, digest.recipient.id));
  }

  if (digest.slackReplied.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`✔️ Slack — you replied · ${digest.slackReplied.length}`));
    blocks.push(...lines(digest.slackReplied.map((m) =>
      `• ${link(m.permalink, m.isDm ? `DM from ${m.author}` : `#${m.channelName}`)} _(${esc(m.author)})_` +
      (m.acknowledgedByReaction ? ' · reacted' : ''))));
  }

  if (digest.mentionsAnswered.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`💬 Asked you — you replied · ${digest.mentionsAnswered.length}`));
    blocks.push(...lines(digest.mentionsAnswered.map((m) => `• ${link(m.link, cleanTaskName(m.taskName))} _(${esc(m.author)})_`)));
  }


  const title = kind === 'week'
    ? `Your week — ${digest.dayLabel}`
    : isStandup ? `Yesterday — ${digest.dayLabel}` : `Your day — ${digest.dayLabel}`;
  // Everything is sent. Past Slack's fifty blocks the rest follows as a second message,
  // rather than the tail being cut off as it used to be.
  return paginate({ text: title, blocks });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
