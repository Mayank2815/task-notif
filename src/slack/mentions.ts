import { DateTime } from 'luxon';

export interface SlackMention {
  channelId: string;
  channelName: string;
  isDm: boolean;
  author: string;
  text: string;
  ts: string;
  at: string;
  permalink: string;
  threadTs: string | null;
  /** True when this person replied, or acknowledged with an emoji reaction. */
  answered: boolean;
  /** They reacted rather than replying — an ack, still an answer. */
  acknowledgedByReaction: boolean;
  /** How many people the message tags — a large number usually means a broadcast. */
  mentionCount: number;
  /** True when this person appears only inside a "cc"/"fyi" list. */
  ccOnly: boolean;
  /** Someone else who was tagged in the same message has replied in the thread. */
  answeredByOther: boolean;
  /** Display names of the co-mentioned people who replied. */
  otherRespondents: string[];
  /** channelId:threadTs — the stable key used for dismissals. */
  key: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const GAP_MS = 1200; // search.messages is Tier 2 (~20/min); this keeps us comfortably under

/** Domains and words that indicate a call was set up or held. */
const MEETING_TERMS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'huddle'];

export interface ChannelActivity {
  channel: string;
  isDm: boolean;
  messages: number;
  /** Newest message you posted there, for context. */
  latest: string;
  permalink: string;
}

export interface MeetingMention {
  channel: string;
  isDm: boolean;
  author: string;
  text: string;
  at: string;
  permalink: string;
}

/** Same courtesy-copy markers as the Teamwork side. */
const CC_MARKERS = /\b(?:cc|bcc|fyi|copying|looping in|adding)\b[\s:,\-]*/gi;
/** A run of raw Slack mention tokens, optionally comma/&/and separated. */
const MENTION_RUN = /^(?:[([{\s]*<@U[A-Z0-9]+>[)\]}]*[\s,;&]*(?:and\s+)?)+/;

/**
 * Is this person named only inside a cc list?
 * Works on the raw "<@U123>" tokens, which are unambiguous — after name resolution the
 * text contains spaces ("@Priya Sharma") and run boundaries stop being reliable.
 */
export function isCcOnly(rawText: string, userId: string): boolean {
  const token = `<@${userId}>`;
  if (!rawText.includes(token)) return false;

  const spans: [number, number][] = [];
  CC_MARKERS.lastIndex = 0;
  let marker: RegExpExecArray | null;
  while ((marker = CC_MARKERS.exec(rawText)) !== null) {
    const from = marker.index + marker[0].length;
    const run = MENTION_RUN.exec(rawText.slice(from));
    if (run && run[0].trim().length > 0) spans.push([from, from + run[0].length]);
  }
  if (spans.length === 0) return false;

  let index = rawText.indexOf(token);
  while (index !== -1) {
    const inCc = spans.some(([from, to]) => index >= from && index < to);
    if (!inCc) return false; // named somewhere that is not a cc list
    index = rawText.indexOf(token, index + 1);
  }
  return true;
}

/**
 * Searches a person's own Slack for mentions of them, using their user token.
 * A bot token cannot do this — search.messages rejects them — and one person's
 * token can only ever see their own Slack, which is why each recipient needs their own.
 */
export class SlackMentionSearch {
  private gate: Promise<void> = Promise.resolve();

  /** `names` maps userId -> display name so message text reads as people, not ids. */
  constructor(private readonly userToken: string, private readonly names: Map<string, string> = new Map()) {}

  private throttle(): Promise<void> {
    const wait = this.gate.then(() => new Promise<void>((r) => setTimeout(r, GAP_MS)));
    this.gate = wait;
    return wait;
  }

  private async call<T extends SlackApiResponse>(method: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle();
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.userToken}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: new URLSearchParams(params).toString(),
      });

      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 5) * 1000));
        continue;
      }

      const data = (await res.json()) as T;
      if (!data.ok) throw new Error(`slack ${method}: ${data.error ?? 'unknown'}`);
      return data;
    }
    throw new Error(`slack ${method}: rate limited after retries`);
  }

  /** Whose token this is. The username is what search matches on. */
  async whoami(): Promise<{ userId: string; username: string; team: string }> {
    const r = await this.call<SlackApiResponse & { user: string; user_id: string; team: string }>('auth.test', {});
    return { userId: r.user_id, username: r.user, team: r.team };
  }

  /**
   * Mentions of this person on a given local date.
   * Slack's search is fuzzy, so results are re-filtered on the literal "<@UID>" token.
   */
  async mentionsOn(date: DateTime, timezone: string, maxTaggedPeople = 0): Promise<SlackMention[]> {
    return this.runSearch(`on:${date.setZone(timezone).toFormat('yyyy-MM-dd')}`, maxTaggedPeople);
  }

  /**
   * Where this person actually spoke on a given day, grouped by conversation.
   * 100+ individual messages is noise; "12 messages in #x" is a stand-up line.
   */
  async myActivityOn(date: DateTime, timezone: string): Promise<ChannelActivity[]> {
    const { username } = await this.whoami();
    const day = date.setZone(timezone).toFormat('yyyy-MM-dd');
    const search = await this.call<SlackApiResponse & { messages?: { matches?: Record<string, unknown>[] } }>(
      'search.messages',
      { query: `from:@${username} on:${day}`, count: '100', sort: 'timestamp' },
    );

    const grouped = new Map<string, ChannelActivity>();
    for (const m of search.messages?.matches ?? []) {
      const channel = (m.channel ?? {}) as Record<string, unknown>;
      const isDm = Boolean(channel.is_im) || Boolean(channel.is_mpim);
      const rawName = String(channel.name ?? channel.id ?? '');
      // A DM's "name" is the other person's user id; show who it was instead.
      const label = isDm ? `DM · ${this.names.get(rawName) ?? rawName}` : `#${rawName}`;

      const existing = grouped.get(label);
      const text = cleanText(String(m.text ?? ''), this.names);
      if (existing) {
        existing.messages += 1;
        if (text) existing.latest = text;
      } else {
        grouped.set(label, {
          channel: label, isDm, messages: 1, latest: text,
          permalink: String(m.permalink ?? ''),
        });
      }
    }

    return [...grouped.values()].sort((a, b) => b.messages - a.messages);
  }

  /** Calls set up or held on a given day, in anything this person can see. */
  async meetingsOn(date: DateTime, timezone: string): Promise<MeetingMention[]> {
    const day = date.setZone(timezone).toFormat('yyyy-MM-dd');
    const seen = new Set<string>();
    const out: MeetingMention[] = [];

    for (const term of MEETING_TERMS) {
      const search = await this.call<SlackApiResponse & { messages?: { matches?: Record<string, unknown>[] } }>(
        'search.messages',
        { query: `${term} on:${day}`, count: '20', sort: 'timestamp' },
      );
      for (const m of search.messages?.matches ?? []) {
        const permalink = String(m.permalink ?? '');
        if (!permalink || seen.has(permalink)) continue;
        seen.add(permalink);
        const channel = (m.channel ?? {}) as Record<string, unknown>;
        const isDm = Boolean(channel.is_im) || Boolean(channel.is_mpim);
        out.push({
          channel: isDm ? `DM · ${this.names.get(String(channel.name ?? '')) ?? 'direct message'}` : `#${channel.name ?? channel.id}`,
          isDm,
          author: this.names.get(String(m.user ?? '')) ?? String(m.username ?? 'someone'),
          text: cleanText(String(m.text ?? ''), this.names),
          at: tsToIso(String(m.ts ?? '')),
          permalink,
        });
      }
    }

    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Mentions from the last `days` days — used for the morning carry-forward. */
  async mentionsSince(days: number, timezone: string, maxTaggedPeople = 0): Promise<SlackMention[]> {
    // Slack's `after:` is exclusive, so step back one extra day to include the boundary.
    const from = DateTime.now().setZone(timezone).minus({ days }).toFormat('yyyy-MM-dd');
    return this.runSearch(`after:${from}`, maxTaggedPeople);
  }

  private async runSearch(dateFilter: string, maxTaggedPeople: number): Promise<SlackMention[]> {
    const { userId, username } = await this.whoami();
    const literal = `<@${userId}>`;

    const search = await this.call<SlackApiResponse & { messages?: { matches?: Record<string, unknown>[] } }>(
      'search.messages',
      { query: `@${username} ${dateFilter}`, count: '100', sort: 'timestamp' },
    );

    const matches = (search.messages?.matches ?? [])
      .filter((m) => String(m.text ?? '').includes(literal))
      // Forwarding a message quotes its @mention, so you can "mention" yourself.
      .filter((m) => String(m.user ?? '') !== userId)
      // A message tagging half the channel is a broadcast, not a question for you.
      .filter((m) => maxTaggedPeople <= 0 || (String(m.text ?? '').match(/<@U[A-Z0-9]+>/g) ?? []).length <= maxTaggedPeople);
    const out: SlackMention[] = [];

    for (const m of matches) {
      const channel = (m.channel ?? {}) as Record<string, unknown>;
      const channelId = String(channel.id ?? '');
      const permalink = String(m.permalink ?? '');
      const ts = String(m.ts ?? '');
      const threadTs = threadTsFrom(permalink);
      const rawText = String(m.text ?? '');
      // Everyone else the message tagged — if one of them answers, it may not need this person.
      const coMentioned = [...new Set((rawText.match(/<@(U[A-Z0-9]+)>/g) ?? [])
        .map((t) => t.slice(2, -1))
        .filter((id) => id !== userId))];

      const thread = await this.analyseThread(
        channelId,
        threadTs,
        ts,
        userId,
        coMentioned,
        Boolean(channel.is_im) || Boolean(channel.is_mpim),
      );

      out.push({
        channelId,
        channelName: String(channel.name ?? channelId),
        isDm: Boolean(channel.is_im) || Boolean(channel.is_mpim),
        author: this.names.get(String(m.user ?? '')) ?? String(m.username ?? m.user ?? 'someone'),
        text: cleanText(String(m.text ?? ''), this.names),
        ts,
        at: tsToIso(ts),
        permalink,
        threadTs,
        answered: thread.answeredByMe || thread.reactedByMe,
        acknowledgedByReaction: thread.reactedByMe && !thread.answeredByMe,
        answeredByOther: thread.answeredByOther,
        otherRespondents: thread.respondents.map((id) => this.names.get(id) ?? id),
        mentionCount: (rawText.match(/<@U[A-Z0-9]+>/g) ?? []).length,
        ccOnly: isCcOnly(rawText, userId),
        key: `${channelId}:${threadTs ?? ts}`,
      });
    }

    // Untouched threads first — a colleague replying is a hint it may be covered,
    // not proof, so those sink rather than disappear.
    return out.sort((a, b) => {
      if (a.answeredByOther !== b.answeredByOther) return a.answeredByOther ? 1 : -1;
      return a.at.localeCompare(b.at);
    });
  }

  /**
   * Who replied after the mention?
   * In a DM the reply is just the next message, so we read the conversation forward.
   * In a channel only a thread reply counts — any later channel message is probably
   * about something else entirely.
   */
  private async analyseThread(
    channelId: string,
    threadTs: string | null,
    mentionTs: string,
    userId: string,
    coMentioned: string[],
    isDm: boolean,
  ): Promise<{ answeredByMe: boolean; reactedByMe: boolean; answeredByOther: boolean; respondents: string[] }> {
    const empty = { answeredByMe: false, reactedByMe: false, answeredByOther: false, respondents: [] as string[] };
    if (!channelId) return empty;

    try {
      let messages: Record<string, unknown>[] = [];

      if (isDm) {
        const r = await this.call<SlackApiResponse & { messages?: Record<string, unknown>[] }>('conversations.history', {
          channel: channelId,
          oldest: mentionTs,
          limit: '50',
        });
        messages = r.messages ?? [];
      } else {
        if (!threadTs) return empty; // a channel message with no thread has nowhere to reply
        const r = await this.call<SlackApiResponse & { messages?: Record<string, unknown>[] }>('conversations.replies', {
          channel: channelId,
          ts: threadTs,
          limit: '100',
        });
        messages = r.messages ?? [];
      }

      const after = messages.filter((m) => String(m.ts) > mentionTs);
      const respondents = [...new Set(after.map((m) => String(m.user)))].filter((id) => coMentioned.includes(id));

      // A 👍 or ✅ on the message that asked is an answer. Include the mention itself,
      // since reacting to it is the most common way to acknowledge.
      const fromMentionOnwards = messages.filter((m) => String(m.ts) >= mentionTs);
      const reactedByMe = fromMentionOnwards.some((m) =>
        ((m.reactions ?? []) as Record<string, unknown>[]).some((r) =>
          ((r.users ?? []) as string[]).includes(userId),
        ),
      );

      return {
        answeredByMe: after.some((m) => String(m.user) === userId),
        reactedByMe,
        answeredByOther: respondents.length > 0,
        respondents,
      };
    } catch {
      // A conversation the history scopes cannot reach must not fail the whole digest.
      return empty;
    }
  }
}

/** Slack puts the thread root in the permalink query string, not on the match object. */
function threadTsFrom(permalink: string): string | null {
  try {
    return new URL(permalink).searchParams.get('thread_ts');
  } catch {
    return null;
  }
}

function tsToIso(ts: string): string {
  const seconds = Number(String(ts).split('.')[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
}

/** Turn Slack's markup into something readable in a message body. */
export function cleanText(text: string, names: Map<string, string> = new Map()): string {
  return text
    // "<@U123|name>" carries the name; "<@U123>" does not and needs the directory.
    .replace(/<@(U[A-Z0-9]+)\|([^>]+)>/g, (_m, _id, name) => `@${name}`)
    .replace(/<@(U[A-Z0-9]+)>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#([A-Z0-9]+)>/g, '#channel')
    // User groups and broadcasts.
    .replace(/<!subteam\^[A-Z0-9]+\|?@?([^>]*)>/g, (_m, name: string) => `@${name || 'group'}`)
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A person's Slack user token. The environment wins over the stored value, so an
 * operator can keep secrets out of the store file entirely if they want to.
 */
/** Environment names are the recipient id upper-cased, so `shriyam-gera` reads SHRIYAM_GERA. */
export function envKeyFor(prefix: string, recipientId: string): string {
  return `${prefix}_${recipientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function userTokenFor(recipientId: string, stored = ''): string | null {
  const fromEnv = process.env[envKeyFor('SLACK_USER_TOKEN', recipientId)];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return stored.trim().length > 0 ? stored.trim() : null;
}
