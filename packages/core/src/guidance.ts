import { RulesData, type AgentId, type ProjectId } from '@round-table/protocol';
import type { ChangeRequestRecord, Model, ProjectRecord, TaskRecord } from './model.ts';

/**
 * The agent's next step, computed from the board (spec D3: agents loop until dismissed).
 * The chat only starts a session; after pairing the Round Table drives the agent: every tool
 * result ends with this step, so the model always knows what to do without a human prompt.
 */
export interface NextStep {
  /** The tool to call next. */
  tool: string;
  /** One or two sentences: what to do and why, with the ids it needs. */
  step: string;
}

export function nextStep(model: Readonly<Model>, projectId: ProjectId, agentId: AgentId): NextStep {
  const project = model.projects[projectId];
  const me = project?.roster[agentId];
  if (!project || !me) return { tool: 'wait', step: 'You are not on this project’s roster. Call wait.' };
  return me.role === 'leader' ? leaderStep(project) : workerStep(project, agentId);
}

const WAIT: NextStep = { tool: 'wait', step: 'Nothing needs you right now. Call wait now; it returns as soon as something arrives.' };

function name(project: ProjectRecord, id: string): string {
  return project.roster[id as AgentId]?.name ?? id;
}

function goalOf(project: ProjectRecord): string | undefined {
  const goal = Object.values(project.entries).find((e) => e.section === 'goal');
  return (goal?.data as { objective?: string } | undefined)?.objective;
}

function testCommand(project: ProjectRecord): string {
  const parsed = RulesData.safeParse(Object.values(project.entries).find((e) => e.section === 'rules')?.data);
  return parsed.success && parsed.data.testCommand ? parsed.data.testCommand : 'the project’s tests';
}

function leaderStep(project: ProjectRecord): NextStep {
  const open = Object.values(project.tickets)
    .filter((t) => t.status === 'open')
    .sort((a, b) => a.openedAt - b.openedAt);
  if (open.length === 1) {
    const ticket = open[0]!;
    return {
      tool: 'board_commit',
      step: `Review proposal ${ticket.ticketId} from ${name(project, ticket.proposer)} (${ticket.op} on ${ticket.section}: ${ticket.reason}); board_get ${ticket.ticketId} shows it. If it serves the goal and doesn't duplicate an existing task or entry, board_commit it; otherwise board_reject it with a reason.`,
    };
  }
  if (open.length > 1) {
    const list = open.map((t) => `${t.ticketId} (${t.section}, from ${name(project, t.proposer)}: ${t.reason})`).join('; ');
    return {
      tool: 'board_commit',
      step: `Review the ${open.length} open proposals: ${list}. Commit the ones that serve the goal in one call, board_commit {ticketIds: [...]}, and board_reject duplicates with a reason.`,
    };
  }
  const tasks = Object.values(project.tasks);
  const goal = goalOf(project);
  if (!goal) return { tool: 'wait', step: 'There is no goal yet; the human sets it in the app. Call wait now: it returns when the goal arrives.' };
  if (tasks.length === 0) {
    const workers = Object.values(project.roster).filter((e) => e.role === 'worker' && (e.state === 'active' || e.state === 'stale')).length;
    return {
      tool: 'board_propose',
      step: `Plan the goal "${goal}" yourself; the workers wait for your plan. Look at the repository if you need to (read only), then propose each task: board_propose {section: "tasks", op: "add", data: {title, criteria: [...], deps: [ticket ids of tasks it needs first]}, reason}. Keep tasks few and small, and have them touch different files so ${workers || 'the'} worker${workers === 1 ? '' : 's'} can work in parallel without conflicts. Then commit the whole plan in one call: board_commit {ticketIds: [...]}.`,
    };
  }
  if (tasks.some((t) => t.status === 'proposed')) {
    return { tool: 'wait', step: 'The plan is waiting for the human’s approval in the app. Call wait.' };
  }
  if (tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'cancelled')) {
    return { tool: 'wait', step: 'All tasks are done. Call wait for the human’s next instruction.' };
  }
  return { tool: 'wait', step: 'You coordinate: nothing needs a decision right now. Call wait.' };
}

function workerStep(project: ProjectRecord, me: AgentId): NextStep {
  const test = testCommand(project);

  // 1. Someone is waiting on me: reviews and tests first, so others aren't blocked.
  const request = Object.values(project.requests)
    .filter((r) => r.to === me && r.status === 'open')
    .sort((a, b) => a.openedAt - b.openedAt)[0];
  if (request) {
    const cr = project.changeRequests[request.changeRequestId];
    const head = cr?.headSha ?? request.headSha;
    const result = request.kind === 'review'
      ? `{kind: "review", verdict: "approved" or "changes_needed", headSha: "${head}", notes}`
      : `{kind: "test", status: "pass" or "fail", headSha: "${head}", evidence}`;
    return {
      tool: 'respond',
      step: `${name(project, request.from)} asked you to ${request.kind} "${cr ? project.tasks[cr.taskId]?.title : ''}" on branch ${cr?.branch} at ${head}. In your worktree run git checkout --detach ${head}, read the task's criteria (board_get ${cr?.taskId}), ${request.kind === 'test' ? `run ${test}` : 'check the change against the criteria'}, then respond {requestId: "${request.requestId}", result: ${result}}.`,
    };
  }

  // 2. My own task.
  const mine = Object.values(project.tasks).find((t) => t.owner === me && t.status !== 'done' && t.status !== 'cancelled');
  if (mine) return ownTaskStep(project, me, mine, test);

  // 3. Something ready to claim.
  const ready = Object.values(project.tasks)
    .filter((t) => t.status === 'ready' && !t.owner && t.deps.every((d) => project.tasks[d]?.status === 'done'))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (ready) return { tool: 'claim', step: `Claim task ${ready.taskId} "${ready.title}" with claim {taskId: "${ready.taskId}"}.` };

  // 4. Nothing planned yet: propose the work (the leader merges duplicates).
  const goal = goalOf(project);
  if (!goal) return { tool: 'wait', step: 'There is no goal yet; the human sets it in the app. Call wait now: it returns when the goal arrives.' };
  const planned = Object.values(project.tasks).length > 0;
  // With a leader, the leader plans: one coherent plan instead of overlapping proposals to reject.
  if (!planned && project.leaderId) return { tool: 'wait', step: 'The leader is drafting the plan. Call wait: it returns when tasks are ready.' };
  const myOpenTicket = Object.values(project.tickets).some((t) => t.proposer === me && t.status === 'open');
  const anyOpenTaskTicket = Object.values(project.tickets).some((t) => t.section === 'tasks' && t.status === 'open');
  if (!planned && !myOpenTicket && !anyOpenTaskTicket) {
    return {
      tool: 'board_propose',
      step: `No tasks exist yet for the goal "${goal}". Propose the work: board_propose {section: "tasks", op: "add", data: {title, criteria: [...]}, reason} (one call per task; keep each small enough for one branch).`,
    };
  }
  return WAIT;
}

function ownTaskStep(project: ProjectRecord, me: AgentId, task: TaskRecord, test: string): NextStep {
  const cr: ChangeRequestRecord | undefined = task.changeRequestId ? project.changeRequests[task.changeRequestId] : undefined;
  const branch = task.branch ?? '';
  if (task.status === 'blocked') return { tool: 'wait', step: `Your task "${task.title}" is blocked. Call wait.` };
  if (task.status === 'in_review' || task.status === 'in_test') {
    return { tool: 'wait', step: `"${task.title}" is ${task.status.replace('_', ' ')}: waiting for verdicts and the hub's merge. Call wait.` };
  }
  if (!cr || cr.status === 'merged') {
    return {
      tool: 'board_propose',
      step: `Work on your task "${task.title}" (criteria: ${task.criteria.join('; ')}). In this folder (your git worktree): git switch -c ${branch} (or git switch ${branch}), make the change, run ${test}, commit. Then open a change request: board_propose {section: "artifacts", op: "open", data: {kind: "change_request", taskId: "${task.taskId}", branch: "${branch}"}, reason}.`,
    };
  }
  if (cr.status === 'rebase_needed') {
    return {
      tool: 'board_propose',
      step: `Your branch ${branch} conflicts with main. Run git rebase main in your worktree, resolve the conflicts, run ${test}, commit, then refresh the change request: board_propose {section: "artifacts", op: "update", data: {changeRequestId: "${cr.changeRequestId}"}, reason}, and ask for review and test again.`,
    };
  }
  const atHead = <T extends { headSha: string }>(xs: T[]) => xs.filter((x) => x.headSha === cr.headSha);
  const rejected = atHead(cr.reviews).find((r) => r.verdict === 'changes_needed') ?? atHead(cr.testResults).find((t) => t.status === 'fail');
  const hubFailed = cr.hubRuns.at(-1);
  if (rejected || (hubFailed && hubFailed.headSha === cr.headSha && hubFailed.status !== 'pass')) {
    const why = rejected ? ('notes' in rejected ? rejected.notes : rejected.evidence) : `the hub's test run failed: ${hubFailed?.outputTail.slice(-300)}`;
    return {
      tool: 'board_propose',
      step: `Fix "${task.title}": ${why}. Commit on ${branch}, refresh the change request (board_propose {section: "artifacts", op: "update", data: {changeRequestId: "${cr.changeRequestId}"}, reason}), then ask for review and test again.`,
    };
  }
  const openFromMe = Object.values(project.requests).filter((r) => r.from === me && r.changeRequestId === cr.changeRequestId && r.status === 'open' && r.headSha === cr.headSha);
  const needsReview = !atHead(cr.reviews).some((r) => r.verdict === 'approved') && !openFromMe.some((r) => r.kind === 'review');
  const needsTest = !atHead(cr.testResults).some((t) => t.status === 'pass') && !openFromMe.some((r) => r.kind === 'test');
  if (needsReview || needsTest) {
    const peers = Object.values(project.roster).filter((e) => e.agentId !== me && e.role === 'worker' && (e.state === 'active' || e.state === 'stale'));
    // The least busy peer: fewest open requests, then no task of its own in hand.
    const load = (id: AgentId) =>
      Object.values(project.requests).filter((r) => r.to === id && r.status === 'open').length * 2 +
      (Object.values(project.tasks).some((t) => t.owner === id && t.status !== 'done' && t.status !== 'cancelled') ? 1 : 0);
    const idlest = [...peers].sort((x, y) => load(x.agentId) - load(y.agentId))[0];
    const reviewer = (task.reviewer && task.reviewer !== me ? task.reviewer : undefined) ?? idlest?.agentId;
    const tester = (task.tester && task.tester !== me ? task.tester : undefined) ?? reviewer;
    if (!reviewer) return { tool: 'wait', step: `"${task.title}" needs a reviewer and tester, but no other worker is on the team yet. Call wait.` };
    const asks = [
      needsReview ? `request {to: "${reviewer}", kind: "review", ref: "${cr.changeRequestId}"} (${name(project, reviewer)})` : '',
      needsTest ? `request {to: "${tester}", kind: "test", ref: "${cr.changeRequestId}"} (${name(project, tester!)})` : '',
    ].filter(Boolean);
    return { tool: 'request', step: `Ask another worker to check your change: ${asks.join(' and ')}.` };
  }
  return { tool: 'wait', step: `"${task.title}" is waiting for its review and test. Call wait.` };
}
