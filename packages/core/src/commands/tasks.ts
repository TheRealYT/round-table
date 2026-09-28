import type { AgentId, PendingEvent, ProjectId, TaskId } from '@round-table/protocol';
import { authorOf, HUB, inProject, makeEvent, type Author } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';
import type { ProjectRecord, TaskRecord } from '../model.ts';
import type { Ctx } from '../ports.ts';
import { canTransition, type TaskStatus, type TransitionCause } from '../tasks/status.ts';
import { displayName, freeWorkers, hubMessage } from './notify.ts';

/** A status change, checked against the task state machine. Throws on an illegal move: that is a bug in a handler. */
export function moveTask(
  ctx: Ctx,
  author: Author,
  project: ProjectRecord,
  task: TaskRecord,
  to: TaskStatus,
  cause: TransitionCause,
  reason: string,
): PendingEvent {
  if (!canTransition(task.status, to, cause)) throw new Error(`illegal task move ${task.status} -> ${to} (${cause})`);
  return makeEvent(ctx, author, inProject(project.projectId), 'task.status_changed', { taskId: task.taskId, from: task.status, to, cause, reason }, { refs: { task: [task.taskId] } });
}

/** Suggested branch for a task: one branch per task (spec: Code sharing). */
export function taskBranch(taskId: string): string {
  return `rt/${taskId.slice(-8).toLowerCase()}`;
}

/** F2, S2 subset: the human approves the plan; proposed tasks become ready. */
export const approvePlan: CommandHandler<{ projectId: ProjectId }> = (model, command, ctx) => {
  if (command.principal.kind !== 'human') return reject('forbidden', 'human only');
  const project = model.projects[command.input.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const proposed = Object.values(project.tasks).filter((t) => t.status === 'proposed');
  if (proposed.length === 0) return reject('nothing_to_approve', 'no proposed tasks');
  const author = authorOf(command.principal);
  const events = proposed.map((t) => moveTask(ctx, author, project, t, 'ready', 'human', 'plan approved by the human'));
  events.push(
    // Only workers without a task need to act on it; the leader and busy workers see it on the board.
    ...hubMessage(ctx, project.projectId, freeWorkers(project), {
      priority: 'direct',
      type: 'alert',
      body: `The human approved the plan: ${proposed.length} task${proposed.length === 1 ? ' is' : 's are'} ready. Claim one that fits you (board_read "tasks", then claim).`,
    }),
  );
  return accept(events, { ready: proposed.map((t) => t.taskId) });
};

export const claim: CommandHandler<{ taskId: TaskId }> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker') return reject('forbidden', 'workers only; the leader coordinates and never takes tasks');
  const project = model.projects[principal.projectId];
  const task = project?.tasks[command.input.taskId];
  if (!project || !task) return reject('unknown_task', 'no such task');
  if (task.owner) return reject('already_claimed', `already claimed by ${displayName(project, task.owner)}`, { owner: task.owner });
  if (task.status !== 'ready') return reject('not_ready', `task is ${task.status}; only ready tasks can be claimed`);
  const openDeps = task.deps.filter((d) => project.tasks[d]?.status !== 'done');
  if (openDeps.length > 0) return reject('blocked_by_deps', 'dependencies are not done yet', { deps: openDeps });
  const branch = taskBranch(task.taskId);
  const author = authorOf(principal);
  return accept(
    [
      makeEvent(ctx, author, inProject(project.projectId), 'task.claimed', { taskId: task.taskId, owner: principal.agentId, branch }, { refs: { task: [task.taskId] } }),
      moveTask(ctx, author, project, task, 'claimed', 'hub_rule', 'claimed'),
    ],
    {
      taskId: task.taskId,
      title: task.title,
      criteria: task.criteria,
      branch,
      next: `Work on branch ${branch} in your worktree (git switch -c ${branch}). Commit, then open a change request: board_propose section "artifacts", op "open", data {kind: "change_request", taskId: "${task.taskId}", branch: "${branch}"}.`,
    },
  );
};

export const release: CommandHandler<{ taskId: TaskId; reason: string; handoffNote?: string }> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker') return reject('forbidden', 'workers only');
  const project = model.projects[principal.projectId];
  const task = project?.tasks[command.input.taskId];
  if (!project || !task) return reject('unknown_task', 'no such task');
  if (task.owner !== principal.agentId) return reject('not_owner', 'you do not own this task');
  if (!['claimed', 'in_progress'].includes(task.status)) return reject('cannot_release', `a task in ${task.status} cannot be released; ask the leader`);
  const author = authorOf(principal);
  return accept([
    makeEvent(ctx, author, inProject(project.projectId), 'task.released', { taskId: task.taskId, owner: principal.agentId, handoffNote: command.input.handoffNote ?? null }, { reason: command.input.reason }),
    moveTask(ctx, author, project, task, 'ready', 'hub_rule', `released: ${command.input.reason}`),
    ...hubMessage(ctx, project.projectId, [project.leaderId], {
      priority: 'direct',
      type: 'alert',
      ref: task.taskId,
      body: `${displayName(project, principal.agentId)} released "${task.title}": ${command.input.reason}`,
    }),
  ]);
};

/** Hub rule: the owner reporting activity on a claimed task means work started (claimed → in_progress). */
export function startedWork(ctx: Ctx, project: ProjectRecord, agentId: AgentId, taskId: string | undefined): PendingEvent[] {
  const task = taskId ? project.tasks[taskId as TaskId] : undefined;
  if (!task || task.owner !== agentId || task.status !== 'claimed') return [];
  return [moveTask(ctx, HUB, project, task, 'in_progress', 'hub_rule', 'owner reported activity on it')];
}
