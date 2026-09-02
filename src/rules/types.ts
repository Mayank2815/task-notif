import type { DateTime } from 'luxon';
import type { Config } from '../config/schema.js';
import type { Identity } from '../teamwork/identity.js';
import type { TeamworkComment, TeamworkTask, TeamworkUser } from '../teamwork/types.js';

export interface RuleContext {
  identity: Identity;
  config: Config;
  now: DateTime;
  /** Comments for the task being evaluated, oldest first. */
  comments: TeamworkComment[];
  usersById: Map<number, TeamworkUser>;
}

export interface RuleMatch {
  ruleId: string;
  /** Short explanation shown under the task in Slack. */
  detail: string;
  /** Deep link — to the triggering comment when there is one, else the task. */
  link: string;
}

export interface Rule {
  id: string;
  /** Slack group heading. */
  label: string;
  /** Lower wins when one task trips several rules. */
  priority: number;
  evaluate(task: TeamworkTask, ctx: RuleContext): RuleMatch | null;
}
