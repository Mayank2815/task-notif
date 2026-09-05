import { DateTime } from 'luxon';
import type { Config, JobKind } from './config/schema.js';
import { getDismissals, recordRun } from './config/store.js';
import { buildDigest, standupWindow } from './digest.js';
import { writeStandupSummary } from './llm/standup.js';
import { collectWorkspace, makeClient, runScan, type ScanResult } from './pipeline.js';
import { SlackClient } from './slack/client.js';
import { renderDigest } from './slack/digest-message.js';
import { renderReminder } from './slack/message.js';
import {
  SlackMentionSearch, userTokenFor,
  type ChannelActivity, type MeetingMention, type SlackMention,
} from './slack/mentions.js';

export interface DeliveryOutcome {
  scan: ScanResult | null;
  perRecipient: { id: string; matched: number; delivered: boolean; error: string | null }[];
}

/** Builds the right message for the job and DMs each enabled recipient.
 *  One recipient failing must not stop the others. */
export async function runAndDeliver(
  configInput: Config,
  teamworkToken: string,
  slackToken: string,
  job: JobKind,
  trigger: 'scheduled' | 'manual',
  log: (m: string) => void = () => {},
  note?: string,
): Promise<DeliveryOutcome> {
  // Testing must not reach colleagues. This narrows manual sends no matter how they
  // were invoked — CLI, dashboard button, or an explicit recipient in the request.
  let config = configInput;
  if (trigger === 'manual' && config.manualSendOnlyTo) {
    const only = config.manualSendOnlyTo;
    const known = config.recipients.some((r) => r.id === only);
    if (!known) throw new Error(`manualSendOnlyTo is "${only}" but no such recipient exists`);
    const suppressed = config.recipients.filter((r) => r.enabled && r.id !== only).map((r) => r.id);
    if (suppressed.length > 0) log(`manual send restricted to "${only}" — not sending to ${suppressed.join(', ')}`);
    config = { ...config, recipients: config.recipients.map((r) => ({ ...r, enabled: r.id === only })) };
  }

  const slack = new SlackClient(slackToken);
  const perRecipient: DeliveryOutcome['perRecipient'] = [];

  // A failure during the scan happens before any per-recipient bookkeeping, so it
  // would otherwise vanish — the dashboard would show nothing at all for that slot.
  const recordFailure = (err: Error): never => {
    recordRun({
      at: new Date().toISOString(),
      job,
      trigger,
      ok: false,
      detail: `scan failed before sending: ${err.message}`,
      perRecipient: [],
    });
    throw err;
  };

  // Fetched once and shared: mention text is full of raw "<@U123>" ids otherwise.
  let names = new Map<string, string>();
  if (config.slackMentionsEnabled) {
    try {
      names = await slack.userDirectory();
      log(`resolved ${names.size} Slack display names`);
    } catch (err) {
      log(`could not load Slack user directory — ids will show raw: ${(err as Error).message}`);
    }
  }

  const messages: { recipient: Config['recipients'][number]; total: number; rendered: ReturnType<typeof renderReminder> }[] = [];
  let scan: ScanResult | null = null;

  if (job === 'reminder') {
    scan = await runScan(config, teamworkToken, log).catch(recordFailure);

    // One Slack search per person covers both halves: the pending window already
    // spans yesterday, so yesterday's mentions are filtered out of the same result
    // rather than fetched again. Doing it twice roughly doubled a run that was
    // already the slowest thing here.
    const client = makeClient(config, teamworkToken);
    const wantYesterday = config.includeYesterdayInReminder;
    // On a Monday this spans Friday to Sunday, so the weekend is never skipped.
    const span = standupWindow(config);
    const dayOffsets = Array.from({ length: span.days }, (_, i) => i + 1);
    if (wantYesterday && span.days > 1) log(`stand-up covers ${span.days} days: ${span.label}`);

    const ws = wantYesterday ? scan.workspace : null;
    const activity = wantYesterday
      ? await client.activitySince(span.start.toUTC().toISO() ?? '').catch(recordFailure)
      : [];

    for (const result of scan.results) {
      const r = result.recipient;
      // The pending search must reach back past the window's first day, since
      // Slack's `after:` filter excludes the date it is given.
      const pending = await slackMentionsFor(config, r.id, 'pending', log, names, span.days + 1);
      const awaiting = pending.filter((m) => !m.answered);

      let summary: string | null = null;
      if (wantYesterday && ws) {
        const mentions = pending.filter((m) => {
          const at = DateTime.fromISO(m.at);
          return at >= span.start && at <= span.end;
        });
        const { activity: slackActivity, meetings } = await slackDayFor(config, r.id, dayOffsets, log, names);
        const digest = await buildDigest(
          client, { ...ws, activity }, config, r, DateTime.now(), mentions, 1, slackActivity, meetings, span.days,
        );
        summary = await writeStandupSummary(digest, config, (m) => log(`${r.label}: ${m}`));
        log(`${r.label}: ${span.label} — ${digest.updates.length} worked on, ${digest.completed.length} closed, ${slackActivity.length} conversations, ${meetings.length} calls`);
      }

      messages.push({
        recipient: r,
        total: result.total + awaiting.length,
        rendered: renderReminder(result, config.timezone, awaiting, note, summary, span.label, span.days),
      });
    }
  } else {
    // The evening digest covers today so far. Yesterday is reported by the morning
    // reminder instead, so there is one message per half of the day rather than three.
    const client = makeClient(config, teamworkToken);
    const ws = await collectWorkspace(client, log, config).catch(recordFailure);
    const activity = await client
      .activitySince(DateTime.now().setZone(config.timezone).startOf('day').toUTC().toISO() ?? '')
      .catch(recordFailure);
    log(`fetched ${activity.length} activity entries for today`);

    for (const recipient of config.recipients.filter((r) => r.enabled)) {
      const mentions = await slackMentionsFor(config, recipient.id, 'today', log, names);
      const { activity: slackActivity, meetings } = await slackDayFor(config, recipient.id, [0], log, names);
      const digest = await buildDigest(
        client, { ...ws, activity }, config, recipient, DateTime.now(), mentions, 0, slackActivity, meetings,
      );
      digest.summary = await writeStandupSummary(digest, config, (m) => log(`${recipient.label}: ${m}`));
      log(
        `${recipient.label}: ${digest.updates.length} updates, ${digest.mentionsOpen.length} open, ` +
        `${digest.mentionsAnswered.length} answered, slack ${digest.slackReplied.length} replied / ${digest.slackAwaiting.length} awaiting`,
      );
      messages.push({ recipient, total: digest.total, rendered: renderDigest(digest, config.timezone, note) });
    }
  }

  for (const { recipient: r, total, rendered } of messages) {
    try {
      if (total === 0 && !config.sendWhenEmpty) {
        log(`${r.label}: nothing to report, skipping (sendWhenEmpty is off)`);
        perRecipient.push({ id: r.id, matched: 0, delivered: false, error: null });
        continue;
      }

      const target = r.slackTarget || (r.slackEmail ? await slack.lookupUserByEmail(r.slackEmail) : null);
      if (!target) throw new Error(`no Slack target — set slackTarget, or an email Slack knows`);

      await slack.postMessage(target, rendered.text, rendered.blocks, rendered.attachments ?? []);
      log(`${r.label}: delivered ${job} (${total} item(s)) to ${target}`);
      perRecipient.push({ id: r.id, matched: total, delivered: true, error: null });
    } catch (err) {
      const message = (err as Error).message;
      log(`${r.label}: FAILED — ${message}`);
      perRecipient.push({ id: r.id, matched: total, delivered: false, error: message });
    }
  }

  const failures = perRecipient.filter((p) => p.error);
  recordRun({
    at: new Date().toISOString(),
    job,
    trigger,
    ok: failures.length === 0,
    detail: failures.length === 0
      ? `${perRecipient.filter((p) => p.delivered).length} delivered`
      : `${failures.length} failed: ${failures.map((f) => `${f.id}: ${f.error}`).join('; ')}`,
    perRecipient,
  });

  return { scan, perRecipient };
}

/**
 * Slack mentions for one recipient, using that person's own user token.
 * No token means no Slack section — better an honestly Teamwork-only message
 * than a partial list built from somebody else's view of the workspace.
 */
async function slackMentionsFor(
  config: Config,
  recipientId: string,
  window: 'today' | 'yesterday' | 'pending',
  log: (m: string) => void,
  names: Map<string, string> = new Map(),
  minDays = 0,
): Promise<SlackMention[]> {
  if (!config.slackMentionsEnabled) return [];

  const recipient = config.recipients.find((r) => r.id === recipientId);
  const token = userTokenFor(recipientId, recipient?.slackUserToken ?? '');
  if (!token) {
    log(`${recipientId}: no Slack user token — skipping Slack mentions`);
    return [];
  }

  try {
    const search = new SlackMentionSearch(token, names);
    const found = window === 'today'
      ? await search.mentionsOn(DateTime.now(), config.timezone, config.slackBroadcastThreshold)
      : await search.mentionsSince(Math.max(config.slackPendingDays, minDays), config.timezone, config.slackBroadcastThreshold);
    // Same rule as tasks: a thread marked done returns when something new is said in it.
    const dismissedAt = new Map(getDismissals(recipientId).map((d) => [d.key, d.at]));
    const reasons: string[] = [];
    let kept = found;

    const drop = (predicate: (m: SlackMention) => boolean, label: string) => {
      const before = kept.length;
      kept = kept.filter((m) => !predicate(m));
      if (before !== kept.length) reasons.push(`${before - kept.length} ${label}`);
    };

    // Slack cc is kept by default — its own switch, separate from the Teamwork one.
    if (config.slackIgnoreCcOnly) drop((m) => m.ccOnly, 'cc-only');
    // Someone else who was tagged has picked it up.
    if (config.slackHideWhenCoMentionedReplied) drop((m) => !m.answered && m.answeredByOther, 'handled by a co-mentioned colleague');
    drop((m) => {
      const at = dismissedAt.get(m.key);
      return Boolean(at) && m.at <= at!;
    }, 'marked done');

    log(`${recipientId}: ${kept.length} Slack mention(s) in the ${window} window${reasons.length ? ` (${reasons.join(', ')} dropped)` : ''}`);
    return kept;
  } catch (err) {
    // Slack search failing must not cost them the Teamwork half of the message.
    log(`${recipientId}: Slack mention search failed — ${(err as Error).message}`);
    return [];
  }
}

/** Where this person spoke, and what calls happened, on the day being reported. */
/**
 * Slack only answers per-day, so a multi-day window costs one pair of calls per
 * day. Channels seen on more than one day are folded together rather than listed
 * twice, keeping the newest message as the one worth linking.
 */
export function mergeChannelActivity(days: ChannelActivity[][]): ChannelActivity[] {
  const byChannel = new Map<string, ChannelActivity>();
  for (const activity of days) {
    for (const entry of activity) {
      const seen = byChannel.get(entry.channel);
      if (!seen) {
        byChannel.set(entry.channel, { ...entry });
        continue;
      }
      seen.messages += entry.messages;
      if (entry.latest > seen.latest) {
        seen.latest = entry.latest;
        seen.permalink = entry.permalink;
      }
    }
  }
  return [...byChannel.values()];
}

async function slackDayFor(
  config: Config,
  recipientId: string,
  dayOffsets: number[],
  log: (m: string) => void,
  names: Map<string, string>,
): Promise<{ activity: ChannelActivity[]; meetings: MeetingMention[] }> {
  if (!config.slackMentionsEnabled) return { activity: [], meetings: [] };

  const recipient = config.recipients.find((r) => r.id === recipientId);
  const token = userTokenFor(recipientId, recipient?.slackUserToken ?? '');
  if (!token) return { activity: [], meetings: [] };

  const now = DateTime.now().setZone(config.timezone);
  try {
    const search = new SlackMentionSearch(token, names);
    const perDay = await Promise.all(dayOffsets.map(async (offset) => {
      const day = now.minus({ days: offset });
      const [activity, meetings] = await Promise.all([
        search.myActivityOn(day, config.timezone),
        config.includeMeetings ? search.meetingsOn(day, config.timezone) : Promise.resolve([]),
      ]);
      return { activity, meetings };
    }));

    const activity = mergeChannelActivity(perDay.map((d) => d.activity));
    const meetings = [...new Map(
      perDay.flatMap((d) => d.meetings).map((m) => [m.permalink || `${m.channel}:${m.at}`, m]),
    ).values()];

    const over = dayOffsets.length > 1 ? ` over ${dayOffsets.length} days` : '';
    log(`${recipientId}: spoke in ${activity.length} Slack conversation(s)${over}, ${meetings.length} call(s) mentioned`);
    return { activity, meetings };
  } catch (err) {
    // Losing this section must not cost the whole message.
    log(`${recipientId}: Slack day summary failed — ${(err as Error).message}`);
    return { activity: [], meetings: [] };
  }
}
