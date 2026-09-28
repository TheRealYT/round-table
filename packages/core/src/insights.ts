/**
 * Where a project's time went, computed from its event log and the hub-run agents' session steps.
 * Pure: the hub (or `rt report`) reads the rows, this turns them into numbers and plain findings.
 */

export interface InsightRow {
  type: string;
  ts: number;
  actor: string;
  payload: unknown;
}

export interface InsightStep {
  agentId: string;
  at: number;
  kind: string;
  text: string;
  data: Record<string, unknown> | null;
}

/** What started a turn: the hub's kickoff, a nudge from the board, or a message and who sent it. */
export const TURN_TRIGGERS = ['kickoff', 'nudge', 'human', 'critical', 'hub', 'agent', 'broadcast', 'notice'] as const;
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

export interface TaskInsight {
  taskId: string;
  title: string;
  status: string;
  owner: string | null;
  createdAt: number;
  doneAt: number | null;
  /** Milliseconds in each phase; null when the task hasn't reached it. */
  phases: {
    approval: number | null;
    toClaim: number | null;
    coding: number | null;
    verify: number | null;
    hubRun: number | null;
  };
  leadMs: number | null;
  reworks: number;
  conflicts: number;
  failedHubRuns: number;
}

export interface AgentInsight {
  agentId: string;
  name: string;
  role: string;
  turns: number;
  workingMs: number;
  costUsd: number;
  tokens: number;
  /** Turns under 5 s: mostly acknowledgements. */
  shortTurns: number;
  byTrigger: Partial<Record<TurnTrigger, { turns: number; ms: number; costUsd: number }>>;
}

export interface Insights {
  startedAt: number | null;
  endedAt: number | null;
  wallMs: number;
  tasks: TaskInsight[];
  agents: AgentInsight[];
  totals: {
    turns: number;
    workingMs: number;
    costUsd: number;
    tokens: number;
    /** Time from tasks being proposed to the human approving them, summed over approvals. */
    approvalWaitMs: number;
    hubRuns: number;
    hubRunMs: number;
    conflicts: number;
    messages: number;
    broadcasts: number;
    /** Message copies delivered: one per recipient. */
    deliveries: number;
    /** Most tasks being worked on (claimed, not done) at the same time. */
    peakParallel: number;
  };
  /** Plain-language bottlenecks, biggest first. */
  findings: string[];
}

interface MessageLike {
  to: unknown;
  role: string;
  priority: string;
  recipients: string[];
}

export function turnTrigger(step: Pick<InsightStep, 'text' | 'data'>): TurnTrigger {
  const given = step.data?.trigger;
  if (typeof given === 'string' && (TURN_TRIGGERS as readonly string[]).includes(given)) return given as TurnTrigger;
  const text = step.text;
  if (/^\[Round Table\] (You are |The Round Table restarted you)/.test(text)) return 'kickoff';
  if (/^\[Round Table\] next:/.test(text)) return 'nudge';
  if (/HUMAN message|message from the human/.test(text)) return 'human';
  if (/CRITICAL message/.test(text)) return 'critical';
  if (/message from the hub/.test(text)) return 'hub';
  if (/^\[Round Table\] Your role changed/.test(text)) return 'notice';
  return 'agent';
}

export function computeInsights(rows: readonly InsightRow[], steps: readonly InsightStep[] = []): Insights {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const names = new Map<string, string>();
  const roles = new Map<string, string>();
  const tasks = new Map<string, TaskInsight & { at: Record<string, number>; mergeRequestedAt: number | null }>();
  const crTask = new Map<string, string>();
  let hubRuns = 0;
  let hubRunMs = 0;
  let conflicts = 0;
  let messages = 0;
  let broadcasts = 0;
  let deliveries = 0;
  let approvalWaitMs = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const turnEvents: Array<{ agentId: string; ts: number; durationMs: number; costUsd: number; tokens: number }> = [];
  const inProgress = new Set<string>();
  let peakParallel = 0;

  for (const row of sorted) {
    const p = row.payload as Record<string, unknown>;
    switch (row.type) {
      case 'roster.joined':
        names.set(p.agentId as string, p.name as string);
        roles.set(p.agentId as string, p.role as string);
        break;
      case 'roster.role_changed':
        roles.set(p.agentId as string, p.role as string);
        break;
      case 'leader.assigned':
        roles.set(p.agentId as string, 'leader');
        if (p.previous) roles.set(p.previous as string, 'worker');
        break;
      case 'task.created':
        tasks.set(p.taskId as string, {
          taskId: p.taskId as string,
          title: p.title as string,
          status: 'proposed',
          owner: null,
          createdAt: row.ts,
          doneAt: null,
          phases: { approval: null, toClaim: null, coding: null, verify: null, hubRun: null },
          leadMs: null,
          reworks: 0,
          conflicts: 0,
          failedHubRuns: 0,
          at: { created: row.ts },
          mergeRequestedAt: null,
        });
        break;
      case 'task.status_changed': {
        const task = tasks.get(p.taskId as string);
        if (!task) break;
        task.status = p.to as string;
        if (p.from === 'proposed' && p.to === 'ready') {
          task.at.ready = row.ts;
          task.phases.approval = row.ts - task.createdAt;
        }
        if (p.to === 'done') {
          task.doneAt = row.ts;
          task.leadMs = row.ts - task.createdAt;
          if (task.mergeRequestedAt !== null) task.phases.hubRun = row.ts - task.mergeRequestedAt;
          inProgress.delete(task.taskId);
        }
        if (p.to === 'cancelled') inProgress.delete(task.taskId);
        break;
      }
      case 'task.claimed': {
        const task = tasks.get(p.taskId as string);
        if (!task) break;
        task.owner = p.owner as string;
        task.at.claimed = row.ts;
        const ready = task.at.ready ?? task.createdAt;
        task.phases.toClaim = row.ts - ready;
        inProgress.add(task.taskId);
        peakParallel = Math.max(peakParallel, inProgress.size);
        break;
      }
      case 'task.released':
        inProgress.delete(p.taskId as string);
        break;
      case 'change_request.opened': {
        crTask.set(p.changeRequestId as string, p.taskId as string);
        const task = tasks.get(p.taskId as string);
        if (task && task.at.claimed !== undefined && task.at.cr === undefined) {
          task.at.cr = row.ts;
          task.phases.coding = row.ts - task.at.claimed;
        }
        break;
      }
      case 'change_request.updated': {
        const task = tasks.get(crTask.get(p.changeRequestId as string) ?? '');
        if (task) task.reworks += 1;
        break;
      }
      case 'change_request.rebase_needed': {
        conflicts += 1;
        const task = tasks.get(crTask.get(p.changeRequestId as string) ?? '');
        if (task) task.conflicts += 1;
        break;
      }
      case 'merge.requested': {
        const task = tasks.get(crTask.get(p.changeRequestId as string) ?? '');
        if (task) {
          if (task.at.cr !== undefined && task.phases.verify === null) task.phases.verify = row.ts - task.at.cr;
          if (task.mergeRequestedAt === null) task.mergeRequestedAt = row.ts;
        }
        break;
      }
      case 'quality.test_run': {
        hubRuns += 1;
        hubRunMs += (p.durationMs as number) ?? 0;
        const task = tasks.get(crTask.get(p.changeRequestId as string) ?? '');
        if (task && p.status !== 'pass') task.failedHubRuns += 1;
        if (p.status === 'conflict') {
          conflicts += 1;
          if (task) task.conflicts += 1;
        }
        break;
      }
      case 'message.sent':
      case 'human.posted': {
        const m = p as unknown as MessageLike;
        messages += 1;
        deliveries += m.recipients?.length ?? 0;
        if (m.to === 'all') broadcasts += 1;
        break;
      }
      case 'agent.turn_finished':
        turnEvents.push({
          agentId: p.agentId as string,
          ts: row.ts,
          durationMs: (p.durationMs as number) ?? 0,
          costUsd: (p.costUsd as number | null) ?? 0,
          tokens: ((p.inputTokens as number) ?? 0) + ((p.outputTokens as number) ?? 0),
        });
        break;
    }
    if (isActivity(row.type)) {
      firstTs ??= row.ts;
      lastTs = row.ts;
    }
  }

  // Approval wait: each approval moment waits on the newest task it approved.
  const approvals = new Map<number, number>();
  for (const task of tasks.values()) {
    if (task.at.ready === undefined) continue;
    approvals.set(task.at.ready, Math.max(approvals.get(task.at.ready) ?? 0, task.createdAt));
  }
  for (const [readyAt, lastCreated] of approvals) approvalWaitMs += Math.max(0, readyAt - lastCreated);

  // Agents: turns from the log; what started each one from the session steps.
  const agents = new Map<string, AgentInsight>();
  const agentOf = (agentId: string): AgentInsight => {
    let a = agents.get(agentId);
    if (!a) {
      a = { agentId, name: names.get(agentId) ?? agentId, role: roles.get(agentId) ?? 'worker', turns: 0, workingMs: 0, costUsd: 0, tokens: 0, shortTurns: 0, byTrigger: {} };
      agents.set(agentId, a);
    }
    return a;
  };
  for (const t of turnEvents) {
    const a = agentOf(t.agentId);
    a.turns += 1;
    a.workingMs += t.durationMs;
    a.costUsd += t.costUsd;
    a.tokens += t.tokens;
    if (t.durationMs < 5_000) a.shortTurns += 1;
    if (firstTs === null || t.ts - t.durationMs < firstTs) firstTs = t.ts - t.durationMs;
    if (lastTs === null || t.ts > lastTs) lastTs = t.ts;
  }
  const byAgent = new Map<string, InsightStep[]>();
  for (const s of steps) {
    if (s.kind !== 'to_agent' && s.kind !== 'turn') continue;
    const list = byAgent.get(s.agentId) ?? [];
    list.push(s);
    byAgent.set(s.agentId, list);
  }
  for (const [agentId, list] of byAgent) {
    list.sort((x, y) => x.at - y.at);
    let trigger: TurnTrigger | null = null;
    for (const s of list) {
      if (s.kind === 'to_agent') {
        trigger = turnTrigger(s);
        continue;
      }
      if (!trigger) continue;
      const a = agentOf(agentId);
      const slot = (a.byTrigger[trigger] ??= { turns: 0, ms: 0, costUsd: 0 });
      slot.turns += 1;
      slot.ms += Number(s.data?.durationMs ?? 0);
      slot.costUsd += Number(s.data?.costUsd ?? 0);
      trigger = null;
    }
  }

  const agentList = [...agents.values()].sort((a, b) => (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : a.name.localeCompare(b.name)));
  const taskList = [...tasks.values()].map(({ at: _at, mergeRequestedAt: _m, ...t }) => t);
  const wallMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;
  const totals = {
    turns: sum(agentList, (a) => a.turns),
    workingMs: sum(agentList, (a) => a.workingMs),
    costUsd: sum(agentList, (a) => a.costUsd),
    tokens: sum(agentList, (a) => a.tokens),
    approvalWaitMs,
    hubRuns,
    hubRunMs,
    conflicts,
    messages,
    broadcasts,
    deliveries,
    peakParallel,
  };
  return { startedAt: firstTs, endedAt: lastTs, wallMs, tasks: taskList, agents: agentList, totals, findings: findings(wallMs, taskList, agentList, totals) };
}

function isActivity(type: string): boolean {
  return type.startsWith('task.') || type.startsWith('change_request.') || type.startsWith('ticket.') || type === 'quality.test_run' || type === 'review.recorded' || type === 'test.recorded';
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((n, x) => n + f(x), 0);
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function findings(wallMs: number, tasks: Omit<TaskInsight, never>[], agents: AgentInsight[], totals: Insights['totals']): string[] {
  const out: Array<{ weight: number; text: string }> = [];
  if (wallMs <= 0) return [];
  if (totals.approvalWaitMs > 0) {
    out.push({ weight: totals.approvalWaitMs, text: `Waiting for the human to approve the plan took ${formatMs(totals.approvalWaitMs)} (${share(totals.approvalWaitMs, wallMs)} of the run).` });
  }
  const phase = (key: keyof TaskInsight['phases'], label: string) => {
    const xs = tasks.map((t) => t.phases[key]).filter((x): x is number => x !== null);
    if (xs.length === 0) return;
    const total = xs.reduce((a, b) => a + b, 0);
    out.push({ weight: total / Math.max(1, totals.peakParallel), text: `${label}: ${formatMs(total / xs.length)} per task on average (${xs.length} task${xs.length === 1 ? '' : 's'}).` });
  };
  phase('coding', 'Coding (claim to change request)');
  phase('verify', 'Waiting for review and test (change request to merge request)');
  phase('toClaim', 'Ready tasks waiting to be claimed');
  if (totals.hubRuns > 0) {
    out.push({ weight: totals.hubRunMs, text: `The hub ran the checks ${totals.hubRuns} time${totals.hubRuns === 1 ? '' : 's'}, ${formatMs(totals.hubRunMs)} in all (${formatMs(totals.hubRunMs / totals.hubRuns)} each).` });
  }
  const work = agents.reduce((n, a) => n + a.workingMs, 0);
  if (agents.length > 0) {
    const busy = work / (agents.length * wallMs);
    out.push({ weight: (1 - busy) * wallMs * 0.5, text: `Agents were working ${Math.round(busy * 100)}% of the run on average; the rest of the time they sat idle.` });
  }
  const turns = totals.turns;
  const nonWork = agents.reduce((n, a) => n + (a.byTrigger.hub?.turns ?? 0) + (a.byTrigger.broadcast?.turns ?? 0) + (a.byTrigger.notice?.turns ?? 0), 0);
  const shortTurns = agents.reduce((n, a) => n + a.shortTurns, 0);
  if (turns > 0 && shortTurns > 0) {
    out.push({ weight: shortTurns * 10_000, text: `${shortTurns} of ${turns} turns (${share(shortTurns, turns)}) were under 5 s, mostly acknowledging a notice.` });
  }
  if (nonWork > 0) {
    out.push({ weight: nonWork * 8_000, text: `${nonWork} turns were started by hub alerts or notices rather than work.` });
  }
  if (totals.broadcasts > 0) {
    out.push({ weight: totals.broadcasts * 15_000, text: `${totals.broadcasts} message${totals.broadcasts === 1 ? ' was' : 's were'} sent to everyone, ${totals.deliveries} deliveries in all for ${totals.messages} messages.` });
  }
  if (totals.conflicts > 0) {
    out.push({ weight: totals.conflicts * 120_000, text: `${totals.conflicts} merge conflict${totals.conflicts === 1 ? '' : 's'} sent work back to be redone.` });
  }
  const tasksDone = tasks.filter((t) => t.doneAt !== null).length;
  if (tasks.length > 1 && totals.peakParallel <= 1) {
    out.push({ weight: wallMs * 0.3, text: `Tasks ran one at a time (at most ${totals.peakParallel} in progress at once), so the team worked in series.` });
  }
  if (tasksDone > 0) {
    out.push({ weight: 0, text: `${tasksDone} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} done in ${formatMs(wallMs)}, ${turns} turns, $${totals.costUsd.toFixed(2)}.` });
  }
  return out.sort((a, b) => b.weight - a.weight).map((f) => f.text);
}
