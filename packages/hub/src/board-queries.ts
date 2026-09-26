import { nextStep, type ChangeRequestRecord, type EntryRecord, type Model, type ProjectRecord, type RosterEntry, type TaskRecord } from '@round-table/core';
import type { AgentId } from '@round-table/protocol';
import { RpcError } from './session.ts';

/**
 * Read side of the Board API (spec: Board API). Reads the in-memory write model, which is small
 * and authoritative; every answer carries `boardVersion` so proposals can cite what they saw (D5).
 */

const S2_SECTIONS = ['goal', 'rules', 'decisions', 'knowledge', 'tasks', 'roster', 'activity', 'artifacts', 'requests', 'quality'];

export function boardRead(project: ProjectRecord, input: { section: string; filter?: Record<string, unknown>; fields?: string[]; limit: number }) {
  let records: Array<Record<string, unknown>>;
  switch (input.section) {
    case 'goal':
    case 'rules':
    case 'decisions':
    case 'knowledge':
      records = entriesOf(project, input.section).map(entryView);
      break;
    case 'tasks':
      records = Object.values(project.tasks).map((t) => taskView(project, t));
      break;
    case 'roster':
      records = Object.values(project.roster).map(rosterView);
      break;
    case 'activity':
      records = Object.values(project.roster).filter((r) => r.activity).map((r) => ({ agentId: r.agentId, name: r.name, ...r.activity }));
      break;
    case 'artifacts':
      records = Object.values(project.changeRequests).map((c) => changeView(project, c));
      break;
    case 'requests':
      records = Object.values(project.requests).map((r) => ({ ...r }));
      break;
    case 'quality':
      records = Object.values(project.changeRequests).flatMap((c) => c.hubRuns.map((r) => ({ changeRequestId: c.changeRequestId, branch: c.branch, ...r })));
      break;
    default:
      throw new RpcError('unknown_procedure', `board_read("${input.section}") arrives in a later slice; available now: ${S2_SECTIONS.join(', ')}`);
  }
  const filter = input.filter ?? {};
  const matching = records.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
  const limited = matching.slice(0, input.limit);
  const shaped = input.fields && input.fields.length > 0 ? limited.map((r) => Object.fromEntries(input.fields!.map((f) => [f, r[f]]))) : limited;
  return { section: input.section, boardVersion: project.boardVersion, total: matching.length, records: shaped };
}

export function boardView(model: Model, project: ProjectRecord, view: string, agentId: AgentId | undefined) {
  const goal = entriesOf(project, 'goal')[0];
  const rules = entriesOf(project, 'rules')[0];
  const tasks = Object.values(project.tasks);
  const base = {
    boardVersion: project.boardVersion,
    project: { projectId: project.projectId, name: project.name, repo: project.repoId ? model.repos[project.repoId]?.path ?? null : null },
    goal: goal ? entryView(goal) : null,
    rules: rules ? entryView(rules) : null,
  };
  if (view === 'me' && agentId) {
    const me = project.roster[agentId];
    return {
      ...base,
      next: nextStep(model, project.projectId, agentId),
      you: me ? { agentId, name: me.name, role: me.role } : { agentId },
      myTasks: tasks.filter((t) => t.owner === agentId).map((t) => taskView(project, t)),
      requestsToMe: Object.values(project.requests).filter((r) => r.to === agentId && r.status === 'open'),
      readyTasks: tasks.filter((t) => t.status === 'ready' && !t.owner).slice(0, 10).map((t) => taskView(project, t)),
      ...(me?.role === 'leader' && { openTickets: Object.values(project.tickets).filter((t) => t.status === 'open') }),
      recentDecisions: entriesOf(project, 'decisions').slice(-5).map(entryView),
    };
  }
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return {
    ...base,
    taskCounts: counts,
    tasks: tasks.map((t) => ({ taskId: t.taskId, title: t.title, status: t.status, owner: t.owner })),
    roster: Object.values(project.roster).map(rosterView),
    openTickets: Object.values(project.tickets).filter((t) => t.status === 'open').length,
    changeRequests: Object.values(project.changeRequests).map((c) => ({ changeRequestId: c.changeRequestId, taskId: c.taskId, branch: c.branch, status: c.status, headSha: c.headSha })),
  };
}

export function boardGet(project: ProjectRecord, id: string) {
  const prefix = id.split('_')[0];
  const found =
    prefix === 'ent' ? mapOpt(project.entries[id as never], entryView)
    : prefix === 'tsk' ? mapOpt(project.tasks[id as never], (t) => ({ ...taskView(project, t), changeRequest: t.changeRequestId ? changeView(project, project.changeRequests[t.changeRequestId]!) : null }))
    : prefix === 'chg' ? mapOpt(project.changeRequests[id as never], (c) => changeView(project, c))
    : prefix === 'req' ? project.requests[id as never]
    : prefix === 'tkt' ? project.tickets[id as never]
    : prefix === 'agt' ? mapOpt(project.roster[id as never], rosterView)
    : undefined;
  if (!found) throw new RpcError('rejected', `nothing with id ${id} in this project`, { code: 'not_found' });
  return { boardVersion: project.boardVersion, record: found };
}

function mapOpt<T, R>(value: T | undefined, f: (v: T) => R): R | undefined {
  return value === undefined ? undefined : f(value);
}

function entriesOf(project: ProjectRecord, section: string): EntryRecord[] {
  return Object.values(project.entries).filter((e) => e.section === section).sort((a, b) => a.createdAt - b.createdAt);
}

function entryView(e: EntryRecord) {
  return { id: e.entryId, section: e.section, version: e.version, data: e.data, author: e.author, via: e.via, criticality: e.criticality, updatedAt: e.updatedAt, supersedes: e.supersedes };
}

function taskView(project: ProjectRecord, t: TaskRecord) {
  return {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    criteria: t.criteria,
    owner: t.owner,
    ownerName: t.owner ? project.roster[t.owner]?.name ?? null : null,
    reviewer: t.reviewer,
    tester: t.tester,
    deps: t.deps,
    branch: t.branch,
    changeRequestId: t.changeRequestId,
    handoffNote: t.handoffNote,
  };
}

function changeView(project: ProjectRecord, c: ChangeRequestRecord) {
  return {
    changeRequestId: c.changeRequestId,
    taskId: c.taskId,
    title: project.tasks[c.taskId]?.title ?? null,
    branch: c.branch,
    author: c.author,
    headSha: c.headSha,
    status: c.status,
    reviews: c.reviews,
    testResults: c.testResults,
    hubRuns: c.hubRuns,
    mergeSha: c.mergeSha,
  };
}

function rosterView(r: RosterEntry) {
  return { agentId: r.agentId, name: r.name, role: r.role, state: r.state, connected: r.connected, tags: r.tags, capabilities: r.capabilities, client: r.client, epoch: r.epoch, activity: r.activity };
}
