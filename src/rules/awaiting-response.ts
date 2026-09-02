import { snippet } from '../teamwork/identity.js';
import { isAssignedToMe, lastUnansweredMention } from './shared.js';
import type { Rule } from './types.js';

/**
 * Rule A — a task assigned to me where someone @-mentioned me and I have not replied since.
 * Assignment is the only usable split from Rule B: Teamwork auto-subscribes anyone it mentions
 * as a comment follower, so "is a follower" is true for every mention and separates nothing.
 */
export const awaitingResponse: Rule = {
  id: 'awaiting-response',
  label: 'Awaiting my response',
  priority: 1,
  evaluate(task, ctx) {
    if (!isAssignedToMe(task.assigneeIds, ctx.identity.userId)) return null;

    const comment = lastUnansweredMention(ctx);
    if (!comment) return null;

    const author = comment.authorId ? ctx.usersById.get(comment.authorId) : undefined;
    const by = author ? [author.firstName, author.lastName].filter(Boolean).join(' ') : 'Someone';
    return {
      ruleId: this.id,
      detail: `${by}: “${snippet(comment.body)}”`,
      link: comment.url,
    };
  },
};
