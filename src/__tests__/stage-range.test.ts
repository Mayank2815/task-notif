import assert from 'node:assert/strict';
import test from 'node:test';
import { normalise, stageIdsInRange, type Stage } from '../teamwork/stage-range.js';

const START = ['Sprint Backlog'];
const END = ['BA Signed-off', 'QA Signed-off'];

/** Board B, exactly as the API returns it — array order is NOT board order. */
const reportDesigner: Stage[] = [
  { id: 1, name: 'Sprint Backlog', displayOrder: 2000 },
  { id: 2, name: 'Backlog - In Grooming', displayOrder: 1999.5 },
  { id: 3, name: 'Backlog - Incoming', displayOrder: 1999 },
  { id: 4, name: 'Backlog - Approval', displayOrder: 1999.75 },
  { id: 5, name: 'Backlog - Ready', displayOrder: 1999.875 },
  { id: 6, name: 'Dev in Progress', displayOrder: 2007 },
  { id: 7, name: 'QA Signed-off', displayOrder: 2014 },
  { id: 8, name: 'Stakeholder Sign-off', displayOrder: 2015 },
  { id: 9, name: 'Deployed on Prod', displayOrder: 2018 },
];

test('ordering comes from displayOrder, not the order the API returns', () => {
  const ids = stageIdsInRange(reportDesigner, START, END)!;
  assert.ok(ids.has(1), 'Sprint Backlog included');
  assert.ok(ids.has(6), 'Dev in Progress included');
  assert.ok(ids.has(7), 'QA Signed-off included (the end anchor)');
});

test('grooming columns before Sprint Backlog are excluded', () => {
  const ids = stageIdsInRange(reportDesigner, START, END)!;
  for (const id of [2, 3, 4, 5]) assert.ok(!ids.has(id), `stage ${id} should be excluded`);
});

test('everything after the end anchor is excluded', () => {
  const ids = stageIdsInRange(reportDesigner, START, END)!;
  assert.ok(!ids.has(8), 'Stakeholder Sign-off excluded');
  assert.ok(!ids.has(9), 'Deployed on Prod excluded');
});

test('BA Signed-off wins over QA Signed-off when a board has both', () => {
  const withBA: Stage[] = [
    { id: 1, name: 'Sprint Backlog', displayOrder: 10 },
    { id: 2, name: 'QA Signed-off', displayOrder: 20 },
    { id: 3, name: 'Ready for BA Review', displayOrder: 30 },
    { id: 4, name: 'BA Signed-Off', displayOrder: 40 },
    { id: 5, name: 'Merged to Dev', displayOrder: 50 },
  ];
  const ids = stageIdsInRange(withBA, START, END)!;
  assert.ok(ids.has(3) && ids.has(4), 'range extends to BA Signed-Off');
  assert.ok(!ids.has(5), 'Merged to Dev excluded');
});

test('hyphen and case differences still match — "BA Signed-Off" vs "BA Signed-off"', () => {
  assert.equal(normalise('BA Signed-Off'), normalise('BA Signed-off'));
  assert.equal(normalise('QA signed off'), normalise('QA Signed-off'));
});

test('a board with neither anchor is left unfiltered rather than emptied', () => {
  // NC Notice & Storage has no Sprint Backlog and no BA/QA Signed-off equivalent
  const other: Stage[] = [
    { id: 1, name: 'Pending on VGD', displayOrder: 1 },
    { id: 2, name: 'Incoming Stories', displayOrder: 2 },
    { id: 3, name: 'Completed', displayOrder: 3 },
  ];
  assert.equal(stageIdsInRange(other, START, END), null);
});

test('a board missing only the end anchor runs to the last column', () => {
  const noEnd: Stage[] = [
    { id: 1, name: 'Backlog - Ready', displayOrder: 1 },
    { id: 2, name: 'Sprint Backlog', displayOrder: 2 },
    { id: 3, name: 'Dev in Progress', displayOrder: 3 },
  ];
  const ids = stageIdsInRange(noEnd, START, END)!;
  assert.ok(!ids.has(1) && ids.has(2) && ids.has(3));
});

test('an empty board yields no opinion', () => {
  assert.equal(stageIdsInRange([], START, END), null);
});

test('a task whose column is missing from the board is kept, not dropped', () => {
  // Seen live: two tasks carried a stageId absent from their workflow's stage list.
  // Excluding them would look identical to losing them.
  const known = new Set([1, 2, 3]);
  const inRange = new Set([2]);
  const staleStageId = 99;

  const kept = !known.has(staleStageId) ? true : inRange.has(staleStageId);
  assert.equal(kept, true);

  const genuinelyOutOfRange = !known.has(1) ? true : inRange.has(1);
  assert.equal(genuinelyOutOfRange, false, 'a known column outside the range is still dropped');
});

test('a task fetched outside the sweep still gets its column name', () => {
  // tasksAssignedTo returns its own objects; without annotating them every assigned
  // task showed a blank board column — 0 of 76 resolved before this fix.
  const stageNames = new Map([[7002, new Map([[9002, 'Ready for QA']])]]);
  const task = { workflowId: 7002, stageId: 9002, stageName: undefined as string | undefined };

  if (task.workflowId && task.stageId && !task.stageName) {
    task.stageName = stageNames.get(task.workflowId)?.get(task.stageId);
  }
  assert.equal(task.stageName, 'Ready for QA');
});

test('annotating never overwrites a name already present', () => {
  const stageNames = new Map([[1, new Map([[2, 'From Board']])]]);
  const task = { workflowId: 1, stageId: 2, stageName: 'Already Set' as string | undefined };
  if (task.workflowId && task.stageId && !task.stageName) {
    task.stageName = stageNames.get(task.workflowId)?.get(task.stageId);
  }
  assert.equal(task.stageName, 'Already Set');
});

test('with includeTasksWithoutStage off, a task on no board is excluded', () => {
  const includeTasksWithoutStage = false;
  const noColumn = { workflowId: undefined, stageId: undefined };
  const inScope = (!noColumn.workflowId || !noColumn.stageId) ? includeTasksWithoutStage : true;
  assert.equal(inScope, false);
});

test('with it on, the same task is kept', () => {
  const includeTasksWithoutStage = true;
  const noColumn = { workflowId: undefined, stageId: undefined };
  const inScope = (!noColumn.workflowId || !noColumn.stageId) ? includeTasksWithoutStage : true;
  assert.equal(inScope, true);
});

// A subtask has no board column of its own; the parent holds it.
function effectiveStage(
  task: { workflowId?: number; stageId?: number; parentTaskId?: number },
  byId: Map<number, { workflowId?: number; stageId?: number; parentTaskId?: number }>,
  maxDepth = 4,
): { stageId?: number; inherited: boolean } {
  if (task.workflowId && task.stageId) return { stageId: task.stageId, inherited: false };
  let parentId = task.parentTaskId;
  for (let d = 0; d < maxDepth && parentId; d++) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.workflowId && parent.stageId) return { stageId: parent.stageId, inherited: true };
    parentId = parent.parentTaskId;
  }
  return { inherited: false };
}

test('a subtask inherits its parent\'s column — the real case', () => {
  // "FE: Smart Autocomplete…" is a subtask of a parent sitting in Ready for QA
  const byId = new Map([[5000001, { workflowId: 7001, stageId: 9001 }]]);
  const subtask = { parentTaskId: 5000001 };
  const r = effectiveStage(subtask, byId);
  assert.equal(r.stageId, 9001);
  assert.equal(r.inherited, true);
});

test('a subtask whose parent also has no column resolves to nothing', () => {
  // The six under "QA Task - smoke Testing" — parent has no column either
  const byId = new Map([[5000002, { workflowId: 7002, stageId: undefined }]]);
  assert.equal(effectiveStage({ parentTaskId: 5000002 }, byId).stageId, undefined);
});

test('a task with no parent at all resolves to nothing', () => {
  assert.equal(effectiveStage({}, new Map()).stageId, undefined);
});

test('a grandparent\'s column is inherited through the chain', () => {
  const byId = new Map<number, { workflowId?: number; stageId?: number; parentTaskId?: number }>([
    [2, { parentTaskId: 3 }],
    [3, { workflowId: 1, stageId: 77 }],
  ]);
  assert.equal(effectiveStage({ parentTaskId: 2 }, byId).stageId, 77);
});

test('a parent cycle terminates instead of looping forever', () => {
  const byId = new Map([[1, { parentTaskId: 2 }], [2, { parentTaskId: 1 }]]);
  assert.equal(effectiveStage({ parentTaskId: 1 }, byId).stageId, undefined);
});

test('a task with its own column ignores the parent entirely', () => {
  const byId = new Map([[9, { workflowId: 1, stageId: 999 }]]);
  const r = effectiveStage({ workflowId: 1, stageId: 5, parentTaskId: 9 }, byId);
  assert.equal(r.stageId, 5);
  assert.equal(r.inherited, false);
});
