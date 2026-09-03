import type { Digest } from '../digest.js';
import { cleanTaskName } from '../teamwork/identity.js';
import { MAX_BLOCKS, renderSlackRows, sectionHeading, type RenderedMessage } from './message.js';

const MAX_PER_SECTION = 12;

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

/** The end-of-day recap: what you did, what still wants an answer, what landed on you. */
export function renderDigest(digest: Digest, timezone: string, note?: string): RenderedMessage {
  const name = digest.recipient.label || digest.identity.displayName;
  const isStandup = digest.dayOffset > 0;

  if (digest.total === 0) {
    return {
      text: `No Teamwork activity logged — ${digest.dayLabel}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🌙 Nothing logged today', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(digest.dayLabel)} · no comments or updates recorded in Teamwork` }] },
      ],
    };
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: isStandup ? `🗣️ Yesterday — ${digest.dayLabel}` : `🌙 Your day — ${digest.dayLabel}`,
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `${isStandup ? 'For today\'s stand-up' : 'Today so far'} · ${esc(name)}${note ? `  ·  ${esc(note)}` : ''}`,
      }],
    },
  ];

  const section = (text: string) => blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

  if (digest.summary) {
    blocks.push({ type: 'divider' });
    // Already escaped by its builder, and carries links that esc() would break.
    section(`*🗒️ For tomorrow's stand-up*\n${digest.summary}`);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_assembled from the items below_' }] });
  }

  if (digest.updates.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`✅ Worked on / updated · ${digest.updates.length}`));
    for (const u of digest.updates.slice(0, MAX_PER_SECTION)) {
      const tags = [u.isDone ? '`dev done`' : null, u.isBlocker ? '`blocker`' : null].filter(Boolean).join(' ');
      const prs = u.prLinks.length ? `\n🔗 ${u.prLinks.map((p, i) => link(p, u.prLinks.length > 1 ? `PR ${i + 1}` : 'PR')).join('  ')}` : '';
      section(`*${link(u.link, cleanTaskName(u.taskName))}*${tags ? ` ${tags}` : ''}\n>${esc(u.text)}${prs}`);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${u.project ? `${esc(u.project)}  ·  ` : ''}${time(u.at, timezone)}` }],
      });
    }
    if (digest.updates.length > MAX_PER_SECTION) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${digest.updates.length - MAX_PER_SECTION} more_` }] });
    }
  }

  if (digest.completed.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🏁 Completed today · ${digest.completed.length}`));
    section(digest.completed.slice(0, MAX_PER_SECTION).map((c) => `• ${c.link ? link(c.link, cleanTaskName(c.taskName)) : esc(cleanTaskName(c.taskName))}${c.project ? ` _(${esc(c.project)})_` : ''}`).join('\n'));
  }

  if (digest.statusChanges.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🔄 Other changes you made · ${digest.statusChanges.length}`));
    const lines = digest.statusChanges.slice(0, MAX_PER_SECTION).map((s) => `• ${esc(s.description)} _(${time(s.at, timezone)})_`);
    section(lines.join('\n'));
  }

  if (digest.newlyAssigned.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`🆕 Landed on you today · ${digest.newlyAssigned.length}`));
    section(digest.newlyAssigned.slice(0, MAX_PER_SECTION).map((t) => `• ${link(t.link, cleanTaskName(t.taskName))}${t.project ? ` _(${esc(t.project)})_` : ''}`).join('\n'));
  }

  if (digest.mentionsOpen.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`⏳ Asked you — not answered yet · ${digest.mentionsOpen.length}`));
    for (const m of digest.mentionsOpen.slice(0, MAX_PER_SECTION)) {
      section(`*${link(m.link, cleanTaskName(m.taskName))}*\n>${esc(m.text)}`);
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(m.author)}  ·  ${time(m.at, timezone)}` }] });
    }
  }

  if (digest.meetings.length > 0) {
    blocks.push(sectionHeading(`📞 Calls & meetings · ${digest.meetings.length}`));
    for (const m of digest.meetings.slice(0, MAX_PER_SECTION)) {
      section(`*${link(m.permalink, m.channel)}* — ${esc(m.author)}\n>${esc(truncate(m.text, 160))}`);
    }
  }

  if (digest.slackActivity.length > 0) {
    blocks.push(sectionHeading(`🗨️ Where you talked · ${digest.slackActivity.length}`));
    // 100+ individual messages is noise; the conversation and a count is the useful part.
    section(digest.slackActivity.slice(0, 10).map((a) =>
      `• ${link(a.permalink, a.channel)} — ${a.messages} message${a.messages === 1 ? '' : 's'}`).join('\n'));
    if (digest.slackActivity.length > 10) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${digest.slackActivity.length - 10} more_` }] });
    }
  }

  if (digest.slackAwaiting.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`💬 Slack — awaiting your reply · ${digest.slackAwaiting.length}`));
    blocks.push(...renderSlackRows(digest.slackAwaiting, digest.recipient.id));
  }

  if (digest.slackReplied.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`✔️ Slack — you replied · ${digest.slackReplied.length}`));
    section(digest.slackReplied.slice(0, MAX_PER_SECTION).map((m) =>
      `• ${link(m.permalink, m.isDm ? `DM from ${m.author}` : `#${m.channelName}`)} _(${esc(m.author)})_` +
      (m.acknowledgedByReaction ? ' · reacted' : '')).join('\n'));
  }

  if (digest.mentionsAnswered.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(sectionHeading(`💬 Asked you — you replied · ${digest.mentionsAnswered.length}`));
    section(digest.mentionsAnswered.slice(0, MAX_PER_SECTION).map((m) => `• ${link(m.link, cleanTaskName(m.taskName))} _(${esc(m.author)})_`).join('\n'));
  }

  // The digest grows with the day; trimming the tail beats Slack rejecting the message.
  if (blocks.length > MAX_BLOCKS) {
    const hidden = blocks.length - (MAX_BLOCKS - 1);
    blocks.length = MAX_BLOCKS - 1;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…${hidden} more block(s) trimmed to fit Slack's limit_` }] });
  }

  return { text: isStandup ? `Yesterday — ${digest.dayLabel}` : `Your day — ${digest.dayLabel}`, blocks };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
