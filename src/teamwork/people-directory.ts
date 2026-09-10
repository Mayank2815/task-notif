import { guessHandles } from './discovery.js';
import type { TeamworkClient } from './client.js';
import type { TeamworkUser } from './types.js';

/** People change rarely; an hour keeps a burst of replies to one fetch each side. */
const CACHE_MS = 60 * 60_000;

export interface SlackPerson {
  id: string;
  email?: string;
  realName?: string;
  displayName?: string;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const fullName = (p: TeamworkUser) => norm(`${p.firstName ?? ''} ${p.lastName ?? ''}`);

/**
 * The Teamwork person a Slack user is. Email first — 76 of 92 people matched that way when
 * measured. Then the full name, but only when exactly one person has it: tagging the
 * wrong one of two namesakes would notify a stranger.
 */
export function matchPerson(slack: SlackPerson, people: TeamworkUser[]): TeamworkUser | null {
  const email = norm(slack.email);
  if (email) {
    const byEmail = people.find((p) => norm(p.email) === email);
    if (byEmail) return byEmail;
  }
  for (const name of [norm(slack.realName), norm(slack.displayName)]) {
    if (!name) continue;
    const same = people.filter((p) => fullName(p) === name);
    if (same.length === 1) return same[0]!;
  }
  return null;
}

/**
 * Teamwork's own mentions, read out of comment HTML: the handle each person is actually
 * tagged by, tied to their id. Teamwork exposes handles nowhere else in its API.
 */
export function mentionHandlesFromHtml(htmlBodies: string[]): Map<number, string> {
  const found = new Map<number, string>();
  const anchor = /<a\b([^>]*)>@([^<]{1,40})<\/a>/g;
  for (const html of htmlBodies) {
    for (const m of html.matchAll(anchor)) {
      const attrs = m[1] ?? '';
      if (!/data-mention="true"/.test(attrs)) continue;
      const id = Number(/href="[^"]*\/people\/(\d+)"/.exec(attrs)?.[1]);
      if (Number.isFinite(id) && id > 0 && m[2]) found.set(id, m[2].trim());
    }
  }
  return found;
}

/**
 * The handle to show. The link carries the person's id, which is what Teamwork notifies
 * and resolves by, so a guessed handle still reaches the right person — it only has to
 * read correctly. "Kiran menon" guesses to "Kiranm", which is what Teamwork uses.
 */
export function handleFor(person: TeamworkUser, confirmed: Map<number, string>): string {
  return confirmed.get(person.id) ?? guessHandles(person)[0] ?? person.firstName ?? `user${person.id}`;
}

/** Slack and Teamwork people side by side, cached, for turning a Slack tag into a Teamwork one. */
export class PeopleDirectory {
  private people: TeamworkUser[] = [];
  private slack = new Map<string, SlackPerson>();
  private loadedAt = 0;
  private readonly confirmed = new Map<number, string>();

  constructor(
    private readonly teamwork: () => TeamworkClient,
    private readonly slackToken: string,
  ) {}

  /** Handles seen in real comments beat guesses; every thread opened teaches a few more. */
  learn(htmlBodies: string[]): void {
    for (const [id, handle] of mentionHandlesFromHtml(htmlBodies)) this.confirmed.set(id, handle);
  }

  async load(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_MS && this.people.length) return;
    const [people, slack] = await Promise.all([this.teamwork().people(), this.slackPeople()]);
    this.people = people;
    this.slack = new Map(slack.map((s) => [s.id, s]));
    this.loadedAt = Date.now();
  }

  resolve = (slackUserId: string): { teamworkId: number; handle: string; name: string } | null => {
    const s = this.slack.get(slackUserId);
    const person = s ? matchPerson(s, this.people) : null;
    if (!person) return null;
    return {
      teamworkId: person.id,
      handle: handleFor(person, this.confirmed),
      name: [person.firstName, person.lastName].filter(Boolean).join(' '),
    };
  };

  slackName = (slackUserId: string): string => {
    const s = this.slack.get(slackUserId);
    return s?.realName || s?.displayName || 'someone';
  };

  private async slackPeople(): Promise<SlackPerson[]> {
    if (!this.slackToken) return [];
    const out: SlackPerson[] = [];
    let cursor = '';
    // Two hundred a page is what Slack recommends; the loop stops on the last page.
    for (let page = 0; page < 20; page++) {
      const url = `https://slack.com/api/users.list?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.slackToken}` } });
      const data = (await res.json()) as {
        ok: boolean;
        members?: { id: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { email?: string; display_name?: string; real_name?: string } }[];
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) break;
      for (const m of data.members ?? []) {
        if (m.deleted || m.is_bot) continue;
        out.push({
          id: m.id,
          email: m.profile?.email,
          realName: m.profile?.real_name || m.real_name,
          displayName: m.profile?.display_name,
        });
      }
      cursor = data.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return out;
  }
}
