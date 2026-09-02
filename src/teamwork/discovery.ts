import type { TeamworkClient } from './client.js';
import type { TeamworkUser } from './types.js';

/**
 * How much we trust a handle:
 * - `confirmed` — an id-linked markdown mention tied it to this exact user
 * - `seen`      — a guess from their name that genuinely appears in comments
 * - `guessed`   — derived from their name and never observed
 */
export type HandleConfidence = 'confirmed' | 'seen' | 'guessed';

export interface HandleCandidate {
  handle: string;
  confidence: HandleConfidence;
  /** How many times it appears in the scanned comments. */
  count: number;
}

export interface PersonSuggestion {
  id: number;
  name: string;
  email: string;
  /** Best first. */
  candidates: HandleCandidate[];
}

export interface HandleEvidence {
  /** userId -> handle -> count, from id-linked mentions. */
  linked: Map<number, Map<string, number>>;
  /** Every "@handle" seen in comment text, lower-cased, with counts. */
  seen: Map<string, number>;
}

/**
 * Teamwork does not expose the @handle used in mentions anywhere in its API.
 * The only reliable source is a markdown mention in a real comment —
 * "[@ArjunR](/app/people/400002)" — which ties a handle to a user id.
 */
export function discoverHandles(comments: { body: string; htmlBody: string }[]): HandleEvidence {
  const linked = new Map<number, Map<string, number>>();
  const seen = new Map<string, number>();
  const linkedPattern = /\[?@([A-Za-z][A-Za-z0-9._-]{1,30})\]?\((?:[^)]*\/people\/)(\d+)\)/g;
  const anyPattern = /@([A-Za-z][A-Za-z0-9._-]{1,30})/g;

  for (const c of comments) {
    const text = `${c.htmlBody}\n${c.body}`;

    for (const m of text.matchAll(linkedPattern)) {
      const handle = m[1];
      const id = Number(m[2]);
      if (!handle || !Number.isFinite(id)) continue;
      const counts = linked.get(id) ?? new Map<string, number>();
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
      linked.set(id, counts);
    }

    // Plain "@Handle" text carries no id, but proves the handle is real and in use.
    for (const m of text.matchAll(anyPattern)) {
      const handle = m[1]?.toLowerCase();
      if (handle) seen.set(handle, (seen.get(handle) ?? 0) + 1);
    }
  }

  return { linked, seen };
}

/** "Arjun Rao" -> ArjunR, ArjunRandey — the shapes this workspace actually uses. */
export function guessHandles(user: TeamworkUser): string[] {
  const first = (user.firstName ?? '').trim();
  const last = (user.lastName ?? '').trim();
  if (!first) return [];

  const guesses = [
    last ? `${first}${last[0]}` : null,
    last ? `${first}${last}` : null,
    first,
  ].filter((h): h is string => Boolean(h));

  return [...new Set(guesses)];
}

/**
 * Everyone, in one call. The workspace has ~109 people, so the browser filters the
 * list locally rather than round-tripping per keystroke.
 */
/** Ranks a person's possible handles: proven first, then observed, then guesses. */
export function rankCandidates(user: TeamworkUser, evidence: HandleEvidence): HandleCandidate[] {
  const out: HandleCandidate[] = [];
  const taken = new Set<string>();

  for (const [handle, count] of evidence.linked.get(user.id) ?? []) {
    out.push({ handle, confidence: 'confirmed', count });
    taken.add(handle.toLowerCase());
  }

  for (const handle of guessHandles(user)) {
    if (taken.has(handle.toLowerCase())) continue;
    const count = evidence.seen.get(handle.toLowerCase()) ?? 0;
    out.push({ handle, confidence: count > 0 ? 'seen' : 'guessed', count });
    taken.add(handle.toLowerCase());
  }

  const rank = { confirmed: 0, seen: 1, guessed: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.count - a.count);
}

/**
 * Everyone, in one call. The workspace has ~109 people, so the browser filters the
 * list locally rather than round-tripping per keystroke.
 */
export async function listPeople(client: TeamworkClient, evidence: HandleEvidence): Promise<PersonSuggestion[]> {
  const people = await client.people();

  return people
    .map((p) => ({
      id: p.id,
      name: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || `user ${p.id}`,
      email: p.email ?? '',
      candidates: rankCandidates(p, evidence),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Matches on name, email or @handle, so typing "@tar" finds Nikhil. */
export function matchesQuery(person: PersonSuggestion, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^@/, '');
  if (needle.length === 0) return true;
  return (
    person.name.toLowerCase().includes(needle) ||
    person.email.toLowerCase().includes(needle) ||
    person.candidates.some((c) => c.handle.toLowerCase().includes(needle))
  );
}

/** A stable, readable recipient id from a display name. */
export function slugify(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'person';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}
