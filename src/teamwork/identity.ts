import type { TeamworkUser } from './types.js';

export interface Identity {
  userId: number;
  displayName: string;
  /**
   * Exact handles to match after an "@". Teamwork writes mentions as plain
   * "@Handle" text, with no user id in the markup, so the handle IS the key.
   */
  handles: string[];
  emails: string[];
}

export function buildIdentity(user: TeamworkUser, handles: string[]): Identity {
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    userId: user.id,
    displayName: displayName || user.email || `user ${user.id}`,
    handles: unique(handles.map((h) => h.replace(/^@/, '').trim().toLowerCase()).filter((h) => h.length >= 2)),
    emails: unique([user.email].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase())),
  };
}

/**
 * How a comment refers to someone:
 * - `directed`  — addressed to them, so a reply is plausibly expected
 * - `cc`        — named only inside a "cc"/"fyi" courtesy list
 * - `none`      — not referred to at all
 */
export type MentionRole = 'directed' | 'cc' | 'none';

/** Markers that open a courtesy-copy list. The names that follow are copied, not asked. */
const CC_MARKERS = /\b(?:cc|bcc|fyi|copying|looping in|adding)\b[\s:,\-]*/gi;

/** One "@handle", optionally followed by more handles joined by commas/&/and. */
const HANDLE_RUN = /^(?:[([{\s]*@[A-Za-z][A-Za-z0-9._-]*[)\]}]*[\s,;&]*(?:and\s+)?)+/;

/**
 * Teamwork writes mentions in several shapes. Collapse them all to plain "@Handle"
 * so position-based analysis below sees one consistent form.
 */
export function normaliseMentions(raw: string, identity: Identity): string {
  return toPlainText(raw)
    // "[@Handle](/app/people/123)" — markdown mention carrying the user id
    .replace(/\[@([A-Za-z][A-Za-z0-9._-]*)\]\([^)]*\)/g, '@$1')
    // A bare id link with no handle text still means this person.
    .replace(new RegExp(`(?:teamwork://user/|/app/people/)${identity.userId}\\b`, 'gi'), `@${identity.handles[0] ?? ''}`);
}

/** Character spans that sit inside a cc list. */
function ccSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  CC_MARKERS.lastIndex = 0;
  let marker: RegExpExecArray | null;
  while ((marker = CC_MARKERS.exec(text)) !== null) {
    const from = marker.index + marker[0].length;
    const run = HANDLE_RUN.exec(text.slice(from));
    // A marker with no handles after it opens nothing.
    if (run && run[0].trim().length > 0) spans.push([from, from + run[0].length]);
  }
  return spans;
}

/**
 * Word-boundary matching is what keeps colleagues with similar handles apart:
 * "@PriyaS" must not match "@PriyaSandeyX", and "@PriyaSi" must not match "@PriyaSha".
 */
export function mentionRole(comment: { body: string; htmlBody?: string }, identity: Identity): MentionRole {
  const raw = `${comment.htmlBody ?? ''}\n${comment.body ?? ''}`;
  if (!raw.trim()) return 'none';

  // Structured markup carrying the user id is the strongest signal that it is them.
  if (new RegExp(`data-user-?id=["']?${identity.userId}\\b`, 'i').test(raw)) return 'directed';

  const text = normaliseMentions(raw, identity);
  const lower = text.toLowerCase();

  if (identity.emails.some((e) => lower.includes(e))) return 'directed';

  const spans = ccSpans(text);
  let sawCc = false;

  for (const handle of identity.handles) {
    const re = new RegExp(`@${escapeRegExp(handle)}\\b`, 'gi');
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(text)) !== null) {
      const inCc = spans.some(([from, to]) => hit!.index >= from && hit!.index < to);
      if (!inCc) return 'directed';
      sawCc = true;
    }
  }

  return sawCc ? 'cc' : 'none';
}

export function mentionsIdentity(comment: { body: string; htmlBody?: string }, identity: Identity): boolean {
  return mentionRole(comment, identity) !== 'none';
}

/** Teamwork comments carry markdown that reads as noise once quoted in Slack. */
export function stripMarkdown(text: string): string {
  return text
    // fenced code — an npm tarball listing tells the reader nothing
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    // "[@Name](/app/people/123)" -> "@Name"
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teamwork appends " *" to a great many task titles; it is not part of the name. */
export function cleanTaskName(name: string): string {
  return name.replace(/\s*\*\s*$/, '').trim();
}

export function toPlainText(body: string): string {
  return body
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function snippet(body: string, max = 200): string {
  const text = stripMarkdown(toPlainText(body));
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
