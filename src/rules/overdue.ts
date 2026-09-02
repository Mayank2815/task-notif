import { DateTime } from 'luxon';
import { isAssignedToMe } from './shared.js';
import type { Rule } from './types.js';

/** Rule C — assigned to me and the due date has arrived or passed. */
export const overdue: Rule = {
  id: 'overdue',
  label: 'Overdue / due today',
  priority: 3,
  evaluate(task, ctx) {
    if (!task.dueDate) return null;
    if (!isAssignedToMe(task.assigneeIds, ctx.identity.userId)) return null;

    const due = parseDueDate(task.dueDate, ctx.config.timezone);
    if (!due) return null;

    const today = ctx.now.setZone(ctx.config.timezone).startOf('day');
    const diffDays = Math.round(due.diff(today, 'days').days);

    if (diffDays > 0) return null;
    if (diffDays === 0 && !ctx.config.includeDueToday) return null;

    const detail =
      diffDays === 0
        ? 'Due today'
        : `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'} (due ${due.toFormat('d LLL yyyy')})`;

    return { ruleId: this.id, detail, link: task.url };
  },
};

/** Teamwork returns due dates as YYYYMMDD or ISO depending on API version. */
function parseDueDate(raw: string, zone: string): DateTime | null {
  const candidates = [
    DateTime.fromISO(raw, { zone }),
    DateTime.fromFormat(raw, 'yyyyMMdd', { zone }),
  ];
  const hit = candidates.find((d) => d.isValid);
  return hit ? hit.startOf('day') : null;
}
