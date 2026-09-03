/**
 * Restricts tasks to a slice of the board — by default Sprint Backlog through
 * BA Signed-off, so grooming-stage work and already-shipped work stay out.
 *
 * Boards differ per project: names vary in case and hyphenation ("BA Signed-off",
 * "BA Signed-Off"), and several workflows have no BA column at all. So anchors are
 * matched leniently, tried in preference order, and anything unrecognised is INCLUDED
 * rather than dropped — silently hiding a whole project's tasks is the worse failure.
 */

export interface Stage {
  id: number;
  name: string;
  displayOrder: number;
}

/** "BA Signed-Off" and "BA Signed-off" and "ba signed off" are the same column. */
export function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findAnchor(ordered: Stage[], anchors: string[]): number {
  for (const anchor of anchors) {
    const target = normalise(anchor);
    const index = ordered.findIndex((s) => normalise(s.name) === target);
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * The stage ids that fall inside the range for one workflow.
 * Returns null when neither boundary is recognisable — the caller then includes
 * every task in that workflow rather than dropping them all.
 */
export function stageIdsInRange(stages: Stage[], startAnchors: string[], endAnchors: string[]): Set<number> | null {
  if (stages.length === 0) return null;

  const ordered = [...stages].sort((a, b) => a.displayOrder - b.displayOrder);
  const start = findAnchor(ordered, startAnchors);
  const end = findAnchor(ordered, endAnchors);

  if (start === -1 && end === -1) return null;

  const from = start === -1 ? 0 : start;
  const to = end === -1 ? ordered.length - 1 : end;
  if (to < from) return null; // a board whose anchors are out of order tells us nothing

  return new Set(ordered.slice(from, to + 1).map((s) => s.id));
}
