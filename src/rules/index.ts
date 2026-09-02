import { actionRequested } from './action-requested.js';
import { awaitingResponse } from './awaiting-response.js';
import { overdue } from './overdue.js';
import type { Rule } from './types.js';

/** Add a new rule by writing one file and appending it here. */
export const ALL_RULES: Rule[] = [awaitingResponse, actionRequested, overdue];

export function activeRules(disabled: string[]): Rule[] {
  return ALL_RULES.filter((r) => !disabled.includes(r.id)).sort((a, b) => a.priority - b.priority);
}

export type { Rule, RuleContext, RuleMatch } from './types.js';
