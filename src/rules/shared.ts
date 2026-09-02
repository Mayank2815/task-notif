import { mentionRole } from '../teamwork/identity.js';
import type { TeamworkComment } from '../teamwork/types.js';
import type { RuleContext } from './types.js';

/** Phrases that turn a bare mention into an explicit ask. Extend freely — matching is substring, case-insensitive. */
export const REQUEST_PHRASES = [
  'update', 'discuss', 'review', 'check', 'confirm', 'clarify', 'thoughts', 'feedback',
  'please', 'pls', 'can you', 'could you', 'kindly', 'let me know', 'lmk', 'any luck',
  'status', 'eta', 'follow up', 'followup', 'waiting on', 'need your', 'your input',
  'take a look', 'have a look', 'look into', 'advise', 'approve', 'sign off', '?',
];

/** Word-boundary matched so an FYI like "I have updated the task" does not read as a request for an update. */
export function looksLikeRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return REQUEST_PHRASES.some((phrase) => {
    if (!/^[a-z]/.test(phrase)) return lower.includes(phrase);
    return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower);
  });
}

/**
 * The most recent comment addressed to me that I have not replied to since.
 * A courtesy cc asks nothing, so by default it does not count as owing a reply.
 */
export function lastUnansweredMention(ctx: RuleContext): TeamworkComment | null {
  const { comments, identity, config } = ctx;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c) continue;
    if (c.authorId === identity.userId) return null; // my own comment is the latest activity — nothing owed

    const role = mentionRole(c, identity);
    if (role === 'directed') return c;
    if (role === 'cc' && !config.ignoreCcOnlyMentions) return c;
  }
  return null;
}

export function isAssignedToMe(assigneeIds: number[], userId: number): boolean {
  return assigneeIds.includes(userId);
}

export function userLabel(ctx: RuleContext, id: number): string {
  const u = ctx.usersById.get(id);
  if (!u) return `user ${id}`;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `user ${id}`;
}
