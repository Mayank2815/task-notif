import { snippet } from '../teamwork/identity.js';
import { isAssignedToMe, lastUnansweredMention, looksLikeRequest, userLabel } from './shared.js';
import type { Rule } from './types.js';

/** Rule B — the task belongs to someone else but a comment asks me to do something. */
export const actionRequested: Rule = {
  id: 'action-requested',
  label: 'Action requested from me',
  priority: 2,
  evaluate(task, ctx) {
    if (isAssignedToMe(task.assigneeIds, ctx.identity.userId)) return null;

    const comment = lastUnansweredMention(ctx);
    if (!comment || !looksLikeRequest(comment.body)) return null;

    const owner = task.assigneeIds[0] ? userLabel(ctx, task.assigneeIds[0]) : 'unassigned';
    return {
      ruleId: this.id,
      detail: `Owned by ${owner} — “${snippet(comment.body)}”`,
      link: comment.url,
    };
  },
};
