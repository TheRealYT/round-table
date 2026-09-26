/**
 * Task state machine (spec: Shared board → Task status).
 *   proposed → ready → claimed → in_progress → in_review → in_test → done
 *   blocked and cancelled are reachable from any non-terminal state.
 * The hub moves every transition from facts it sees, except `done`, which only the done rule may do.
 */
export const TASK_STATUSES = [
  'proposed',
  'ready',
  'claimed',
  'in_progress',
  'in_review',
  'in_test',
  'done',
  'blocked',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);

const FORWARD: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ['ready'],
  ready: ['claimed'],
  // Release, leave or gone cleanup returns a task to ready with its handoff note (F10).
  claimed: ['in_progress', 'ready'],
  in_progress: ['in_review', 'ready'],
  // changes_needed or a failed hub test run sends work back to in_progress.
  in_review: ['in_test', 'in_progress', 'ready'],
  in_test: ['done', 'in_progress', 'ready'],
  done: [],
  // Unblocking returns the task to where it can continue; the module records the pre-block state.
  blocked: ['ready', 'claimed', 'in_progress', 'in_review', 'in_test'],
  cancelled: [],
};

export type TransitionCause = 'hub_rule' | 'done_rule' | 'human';

export function canTransition(from: TaskStatus, to: TaskStatus, cause: TransitionCause): boolean {
  if (TERMINAL.has(from)) return cause === 'human' && to === 'ready'; // human reopen
  if (to === 'done') return cause === 'done_rule' && from === 'in_test';
  if (to === 'blocked' || to === 'cancelled') return true;
  return FORWARD[from].includes(to);
}
