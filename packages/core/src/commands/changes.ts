import {
  ChangeRequestProposal,
  ChangeRequestRefresh,
  RulesData,
  type AgentId,
  type ChangeRequestId,
  type PendingEvent,
  type Principal,
  type RequestId,
  type Sha,
} from '@round-table/protocol';
import { z } from 'zod';
import { authorOf, HUB, inProject, makeEvent } from '../event.ts';
import { accept, reject, type Command, type CommandHandler, type Decision } from '../module.ts';
import type { ChangeRequestRecord, Model, ProjectRecord, TaskRecord } from '../model.ts';
import type { Ctx } from '../ports.ts';
import { evaluateDoneRule, readyForHubRun } from '../tasks/done-rule.ts';
import { singleton } from './board.ts';
import { displayName, hubMessage } from './notify.ts';
import { moveTask } from './tasks.ts';

/**
 * Change requests, reviews, tests and the merge gate (ADR-0008, ADR-0009). The hub reads branch
 * heads from git before these handlers run (`headSha`, `currentHeadSha`), so every verdict is tied
 * to the exact commit it was about.
 */

type AgentPrincipal = Extract<Principal, { kind: 'worker' | 'leader' }>;

function testRules(project: ProjectRecord): RulesData | undefined {
  const parsed = RulesData.safeParse(singleton(project, 'rules')?.data);
  return parsed.success ? parsed.data : undefined;
}

/** `board_propose('artifacts', …)`: open a change request, or refresh its head after new commits. Committed by the hub. */
export function openOrRefreshChangeRequest(
  _model: Readonly<Model>,
  project: ProjectRecord,
  command: Command<{ op: string; data: unknown; headSha?: string | null }>,
  ctx: Ctx,
): Decision {
  const principal = command.principal as AgentPrincipal;
  if (command.input.op === 'update') {
    const parsed = ChangeRequestRefresh.safeParse(command.input.data);
    if (!parsed.success) return reject('invalid_data', z.prettifyError(parsed.error));
    const cr = project.changeRequests[parsed.data.changeRequestId as ChangeRequestId];
    if (!cr) return reject('unknown_change_request', 'no such change request');
    if (cr.author !== principal.agentId) return reject('not_author', 'only the author refreshes a change request');
    const events = refreshHead(ctx, project, cr, command.input.headSha ?? null);
    return accept(events, { routedTo: 'hub', committed: true, id: cr.changeRequestId, headSha: command.input.headSha ?? cr.headSha, changed: events.length > 0 });
  }
  if (command.input.op !== 'open') return reject('invalid_op', 'artifacts accept op "open" (new change request) or "update" (refresh its head)');
  const parsed = ChangeRequestProposal.safeParse(command.input.data);
  if (!parsed.success) return reject('invalid_data', z.prettifyError(parsed.error));
  const { taskId, branch } = parsed.data;
  if (!project.repoId) return reject('no_repo', 'no repository is attached to this project yet; the human attaches one in the app');
  if (!testRules(project)?.testCommand) {
    return reject('no_test_command', 'the hub runs the tests before merging, but the rules have no testCommand yet; ask the human to set it');
  }
  const task = project.tasks[taskId];
  if (!task) return reject('unknown_task', 'no such task');
  if (task.owner !== principal.agentId) return reject('not_owner', 'only the task owner opens its change request');
  if (!['claimed', 'in_progress'].includes(task.status)) return reject('bad_state', `task is ${task.status}`);
  const open = task.changeRequestId ? project.changeRequests[task.changeRequestId] : undefined;
  if (open && open.status !== 'merged') {
    return reject('already_open', `change request ${open.changeRequestId} is already open for this task; refresh it with op "update"`, { changeRequestId: open.changeRequestId });
  }
  const headSha = command.input.headSha;
  if (!headSha) return reject('unknown_branch', `branch ${branch} does not exist in the repository; commit on it first`);
  const changeRequestId = ctx.ids.next('changeRequest') as ChangeRequestId;
  const author = authorOf(principal);
  const events: PendingEvent[] = [
    makeEvent(ctx, author, inProject(project.projectId), 'change_request.opened', {
      changeRequestId,
      taskId,
      repoId: project.repoId,
      branch,
      headSha: headSha as Sha,
      author: principal.agentId,
    }, { refs: { changeRequest: [changeRequestId], task: [taskId] } }),
  ];
  if (task.status === 'claimed') events.push(moveTask(ctx, author, project, task, 'in_progress', 'hub_rule', 'change request opened'));
  return accept(events, {
    routedTo: 'hub',
    committed: true,
    id: changeRequestId,
    headSha,
    next: `Ask a reviewer and a tester (not yourself, not the leader): request {to, kind: "review", ref: "${changeRequestId}"} and request {to, kind: "test", ref: "${changeRequestId}"}.`,
  });
}

/** New commits on the branch: record the new head; verdicts on the old head stop counting. */
function refreshHead(ctx: Ctx, project: ProjectRecord, cr: ChangeRequestRecord, current: string | null): PendingEvent[] {
  if (!current || current === cr.headSha || cr.status === 'merged') return [];
  const task = project.tasks[cr.taskId];
  const where = inProject(project.projectId);
  const events: PendingEvent[] = [
    makeEvent(ctx, HUB, where, 'change_request.updated', { changeRequestId: cr.changeRequestId, headSha: current as Sha, previous: cr.headSha }, { refs: { changeRequest: [cr.changeRequestId] } }),
  ];
  if (task && task.status === 'in_test') events.push(moveTask(ctx, HUB, project, task, 'in_review', 'hub_rule', 'new commits after approval need review again'));
  const reviewers = [...new Set([...cr.reviews.map((r) => r.by), ...cr.testResults.map((t) => t.by)])];
  events.push(
    ...hubMessage(ctx, project.projectId, reviewers, {
      priority: 'direct',
      type: 'alert',
      ref: cr.changeRequestId,
      body: `New commits on ${cr.branch} (${cr.changeRequestId}, now ${current.slice(0, 10)}). Earlier verdicts no longer count; the author will ask again.`,
    }),
  );
  return events;
}

function findChangeRequest(project: ProjectRecord, ref: string): ChangeRequestRecord | undefined {
  const direct = project.changeRequests[ref as ChangeRequestId];
  if (direct) return direct;
  const task = project.tasks[ref as TaskRecord['taskId']];
  return task?.changeRequestId ? project.changeRequests[task.changeRequestId] : undefined;
}

export const openRequest: CommandHandler<{ to: string; kind: string; ref: string; body?: string; currentHeadSha?: string | null }> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker') return reject('forbidden', 'workers only');
  const project = model.projects[principal.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const { kind, to } = command.input;
  if (kind !== 'review' && kind !== 'test') return reject('not_built', `request kind "${kind}" arrives in S3; use send for now`);
  const cr = findChangeRequest(project, command.input.ref);
  if (!cr) return reject('unknown_change_request', 'ref must be a change request id (or its task id)');
  if (cr.author !== principal.agentId) return reject('not_author', 'only the change request author asks for its review or test');
  if (cr.status === 'merged') return reject('merged', 'already merged');
  if (to === 'all') return reject('invalid_input', 'name one agent');
  const target = project.roster[to as AgentId];
  if (!target || (target.state !== 'active' && target.state !== 'stale')) return reject('unknown_recipient', 'that agent is not on the roster');
  if (to === cr.author) return reject('self_review', 'nobody reviews or tests their own work');
  if (target.role === 'leader') return reject('leader_cannot_review', 'the leader coordinates only; ask a worker');

  const events = refreshHead(ctx, project, cr, command.input.currentHeadSha ?? null);
  const headSha = (command.input.currentHeadSha ?? cr.headSha) as Sha;
  const requestId = ctx.ids.next('request') as RequestId;
  const author = authorOf(principal);
  const task = project.tasks[cr.taskId];
  events.push(
    makeEvent(ctx, author, inProject(project.projectId), 'request.opened', {
      requestId,
      kind,
      from: principal.agentId,
      to: to as AgentId,
      changeRequestId: cr.changeRequestId,
      headSha,
      body: command.input.body ?? null,
    }, { refs: { request: [requestId], changeRequest: [cr.changeRequestId] } }),
    ...hubMessage(ctx, project.projectId, [to as AgentId], {
      priority: 'direct',
      type: 'request',
      ref: requestId,
      body: kind === 'review'
        ? `${displayName(project, principal.agentId)} asks you to review "${task?.title}" on branch ${cr.branch} at ${headSha}. Check it against the task's criteria, then respond {requestId: "${requestId}", result: {kind: "review", verdict: "approved" | "changes_needed", headSha: "${headSha}", notes}}.`
        : `${displayName(project, principal.agentId)} asks you to test "${task?.title}" on branch ${cr.branch} at ${headSha}. Test against the task's criteria (not the author's code), then respond {requestId: "${requestId}", result: {kind: "test", status: "pass" | "fail", headSha: "${headSha}", evidence}}.`,
    }),
  );
  if (kind === 'review' && task?.status === 'in_progress') events.push(moveTask(ctx, author, project, task, 'in_review', 'hub_rule', 'review requested'));
  return accept(events, { requestId, headSha });
};

type RespondResult =
  | { kind: 'review'; verdict: 'approved' | 'changes_needed'; headSha: string; notes: string }
  | { kind: 'test'; status: 'pass' | 'fail'; headSha: string; evidence: string }
  | { kind: 'info'; answer: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'done'; note: string };

export const respond: CommandHandler<{ requestId: RequestId; result: RespondResult; currentHeadSha?: string | null }> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker') return reject('forbidden', 'workers only');
  const project = model.projects[principal.projectId];
  const request = project?.requests[command.input.requestId];
  if (!project || !request) return reject('unknown_request', 'no such request');
  if (request.to !== principal.agentId) return reject('not_target', 'this request was not sent to you');
  if (request.status !== 'open') return reject('request_closed', 'this request is already closed');
  const cr = project.changeRequests[request.changeRequestId];
  const task = cr ? project.tasks[cr.taskId] : undefined;
  if (!cr || !task) return reject('unknown_change_request', 'the change request is gone');
  const result = command.input.result;
  const author = authorOf(principal);
  const where = inProject(project.projectId);
  const refresh = refreshHead(ctx, project, cr, command.input.currentHeadSha ?? null);
  const head = (command.input.currentHeadSha ?? cr.headSha) as Sha;
  const close = (outcome: string) => makeEvent(ctx, author, where, 'request.closed', { requestId: request.requestId, outcome, by: principal.agentId }, { refs: { request: [request.requestId] } });

  if (result.kind === 'declined') {
    return accept([
      ...refresh,
      close('declined'),
      ...hubMessage(ctx, project.projectId, [request.from], { priority: 'direct', type: 'response', ref: request.requestId, body: `${displayName(project, principal.agentId)} declined your ${request.kind} request: ${result.reason}. Ask someone else.` }),
    ]);
  }
  if (result.kind !== request.kind) return reject('wrong_kind', `this is a ${request.kind} request; answer with result.kind "${request.kind}" (or "declined")`);
  if (result.headSha !== head) {
    return reject('stale_head', `the branch moved to ${head}; look at that commit and answer for it`, { headSha: head }, refresh);
  }

  const events: PendingEvent[] = [...refresh];
  // Facts after this verdict, for the task move and the merge gate.
  const facts = { ...cr, headSha: head, reviews: [...cr.reviews], testResults: [...cr.testResults] };
  // After a refresh the task may have moved back to in_review; track the status we are moving from.
  let status = refresh.some((e) => e.type === 'task.status_changed') ? 'in_review' : task.status;
  const moveTo = (to: TaskRecord['status'], reason: string) => {
    events.push(moveTask(ctx, author, project, { ...task, status }, to, 'hub_rule', reason));
    status = to;
  };

  if (result.kind === 'review') {
    events.push(makeEvent(ctx, author, where, 'review.recorded', { changeRequestId: cr.changeRequestId, by: principal.agentId, verdict: result.verdict, headSha: head, notes: result.notes }, { refs: { changeRequest: [cr.changeRequestId] } }), close(result.verdict));
    facts.reviews.push({ by: principal.agentId, verdict: result.verdict, headSha: head, notes: result.notes, at: ctx.now });
    if (result.verdict === 'approved' && status === 'in_review') moveTo('in_test', 'review approved');
    if (result.verdict === 'changes_needed' && (status === 'in_review' || status === 'in_test')) moveTo('in_progress', 'changes needed');
    events.push(...hubMessage(ctx, project.projectId, [request.from], {
      priority: 'direct',
      type: 'response',
      ref: cr.changeRequestId,
      body: `${displayName(project, principal.agentId)} reviewed ${cr.branch} at ${head.slice(0, 10)}: ${result.verdict}${result.notes ? ` (${result.notes})` : ''}.`,
    }));
  } else if (result.kind === 'test') {
    events.push(makeEvent(ctx, author, where, 'test.recorded', { changeRequestId: cr.changeRequestId, by: principal.agentId, status: result.status, headSha: head, evidence: result.evidence }, { refs: { changeRequest: [cr.changeRequestId] } }), close(result.status));
    facts.testResults.push({ by: principal.agentId, status: result.status, headSha: head, evidence: result.evidence, at: ctx.now });
    if (result.status === 'fail' && (status === 'in_review' || status === 'in_test')) moveTo('in_progress', 'tests failed');
    events.push(...hubMessage(ctx, project.projectId, [request.from], {
      priority: 'direct',
      type: 'response',
      ref: cr.changeRequestId,
      body: `${displayName(project, principal.agentId)} tested ${cr.branch} at ${head.slice(0, 10)}: ${result.status}. ${result.evidence}`,
    }));
  } else {
    return reject('not_built', 'info and done results arrive in S3');
  }

  // The merge gate: non-author approval and non-author pass at this head, task in_test → the hub merges and tests.
  const rules = testRules(project);
  if (status === 'in_test' && cr.mergeRequestedFor !== head && readyForHubRun(facts) && rules?.testCommand && project.repoId) {
    events.push(
      makeEvent(ctx, HUB, where, 'merge.requested', {
        changeRequestId: cr.changeRequestId,
        headSha: head,
        repoId: project.repoId,
        testCommand: rules.testCommand,
        testTimeoutSec: rules.testTimeoutSec,
      }, { refs: { changeRequest: [cr.changeRequestId], task: [task.taskId] } }),
    );
  }
  return accept(events, { recorded: result.kind, headSha: head });
};

export interface MergeResultInput {
  changeRequestId: ChangeRequestId;
  headSha: Sha;
  outcome: 'merged' | 'tests_failed' | 'conflict' | 'error';
  mergeSha?: Sha;
  baseSha?: Sha;
  run?: { status: 'pass' | 'fail' | 'timeout' | 'error'; durationMs: number; outputTail: string };
  files?: string[];
  message?: string;
}

/** Internal (merge reactor): the outcome of merging and testing a change request. */
export const mergeResult: CommandHandler<MergeResultInput> = (model, command, ctx) => {
  if (command.principal.kind !== 'hub') return reject('forbidden', 'hub only');
  const input = command.input;
  const project = Object.values(model.projects).find((p) => p.changeRequests[input.changeRequestId]);
  const cr = project?.changeRequests[input.changeRequestId];
  const task = cr && project ? project.tasks[cr.taskId] : undefined;
  if (!project || !cr || !task) return reject('unknown_change_request', 'no such change request');
  const where = inProject(project.projectId);
  const refs = { refs: { changeRequest: [cr.changeRequestId], task: [task.taskId] } };
  const runStatus = input.outcome === 'conflict' ? 'conflict' : (input.run?.status ?? 'error');
  const events: PendingEvent[] = [
    makeEvent(ctx, HUB, where, 'quality.test_run', {
      changeRequestId: cr.changeRequestId,
      headSha: input.headSha,
      status: runStatus,
      durationMs: input.run?.durationMs ?? 0,
      outputTail: input.run?.outputTail ?? input.message ?? (input.files ? `conflicting files: ${input.files.join(', ')}` : ''),
      mergeSha: input.mergeSha ?? null,
    }, refs),
  ];
  // Who a merge concerns: the author, the leader, and owners of tasks that were waiting on this one.
  const waiting = Object.values(project.tasks).filter((t) => t.deps.includes(task.taskId) && t.owner).map((t) => t.owner as AgentId);
  const team = [...new Set([cr.author, project.leaderId, ...waiting])].filter((id): id is AgentId => Boolean(id));

  if (input.outcome === 'merged' && input.mergeSha && input.baseSha) {
    events.push(makeEvent(ctx, HUB, where, 'change_request.merged', { changeRequestId: cr.changeRequestId, headSha: input.headSha, mergeSha: input.mergeSha, baseSha: input.baseSha }, refs));
    const current = cr.headSha === input.headSha;
    const verdict = evaluateDoneRule({ ...cr, hubRuns: [...cr.hubRuns, { headSha: input.headSha, status: 'pass' }] });
    if (current && verdict.met && task.status === 'in_test') {
      events.push(moveTask(ctx, HUB, project, task, 'done', 'done_rule', `merged as ${input.mergeSha.slice(0, 10)}: approved, tested and passing on main`));
      events.push(...hubMessage(ctx, project.projectId, team, { priority: 'direct', type: 'alert', ref: task.taskId, body: `"${task.title}" is done: merged into main as ${input.mergeSha.slice(0, 10)}.` }));
    } else {
      if (task.status === 'in_test') events.push(moveTask(ctx, HUB, project, task, 'in_review', 'hub_rule', 'newer commits arrived during the merge'));
      events.push(...hubMessage(ctx, project.projectId, [cr.author], { priority: 'direct', type: 'alert', ref: cr.changeRequestId, body: `Merged ${input.headSha.slice(0, 10)} into main, but ${cr.branch} has newer commits; those need review and test again.` }));
    }
    return accept(events);
  }

  if (task.status === 'in_test') events.push(moveTask(ctx, HUB, project, task, 'in_progress', 'hub_rule', input.outcome === 'conflict' ? 'merge conflict with main' : 'hub test run failed'));
  if (input.outcome === 'conflict') {
    events.push(makeEvent(ctx, HUB, where, 'change_request.rebase_needed', { changeRequestId: cr.changeRequestId, headSha: input.headSha, files: input.files ?? [] }, refs));
    events.push(...hubMessage(ctx, project.projectId, [cr.author], {
      priority: 'direct',
      type: 'alert',
      ref: cr.changeRequestId,
      body: `${cr.branch} conflicts with main (${(input.files ?? []).join(', ') || 'unknown files'}). Rebase on main, push, then refresh: board_propose artifacts op "update" {changeRequestId: "${cr.changeRequestId}"}, and ask for review and test again.`,
    }));
  } else {
    events.push(...hubMessage(ctx, project.projectId, [cr.author, ...cr.testResults.map((t) => t.by)], {
      priority: 'direct',
      type: 'alert',
      ref: cr.changeRequestId,
      body: `The hub's test run on main + ${cr.branch} (${input.headSha.slice(0, 10)}) ${input.outcome === 'error' ? 'could not run' : 'failed'}: ${(input.run?.outputTail ?? input.message ?? '').slice(-600)}`,
    }));
  }
  return accept(events);
};
