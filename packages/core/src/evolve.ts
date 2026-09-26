import type { EventPayloads, EventRow, PendingEvent } from '@round-table/protocol';
import type { Model } from './model.ts';

type Folder<T extends keyof EventPayloads> = (model: Model, payload: EventPayloads[T], event: PendingEvent) => void;

/**
 * Folds events into the model, in place. Deterministic and total: it never throws on an event
 * `decide` produced, and it reads nothing but the model and the event (so replay is exact).
 */
const FOLDS: { [K in keyof EventPayloads]?: Folder<K> } = {
  'project.created': (m, p, e) => {
    m.projects[p.projectId] = {
      projectId: p.projectId,
      name: p.name,
      createdAt: e.ts,
      leaderId: null,
      roster: {},
      humanMessages: {},
      repoId: null,
      boardVersion: 0,
      entries: {},
      tickets: {},
      tasks: {},
      changeRequests: {},
      requests: {},
    };
  },
  'pairing.requested': (m, p, e) => {
    m.pairing[p.requestId] = {
      requestId: p.requestId,
      name: p.name,
      client: p.client,
      tags: p.tags,
      capabilities: p.capabilities,
      publicKey: p.publicKey,
      fingerprint: p.fingerprint,
      origin: p.origin,
      matchPhrase: p.matchPhrase,
      status: 'pending',
      requestedAt: e.ts,
      expiresAt: p.expiresAt,
      projectId: null,
      codeHash: null,
      codeExpiresAt: null,
      attempts: 0,
      agentId: null,
      resumes: p.resumes ?? null,
    };
  },
  'pairing.allowed': (m, p) => {
    const r = m.pairing[p.requestId];
    if (r) Object.assign(r, { status: 'allowed', projectId: p.projectId, codeHash: p.codeHash, codeExpiresAt: p.codeExpiresAt });
  },
  'pairing.denied': (m, p) => setPairingStatus(m, p.requestId, 'denied'),
  'pairing.expired': (m, p) => setPairingStatus(m, p.requestId, 'expired'),
  'pairing.voided': (m, p) => setPairingStatus(m, p.requestId, 'voided'),
  'pairing.code_failed': (m, p) => {
    const r = m.pairing[p.requestId];
    if (r) r.attempts = p.attempts;
  },
  'pairing.origin_blocked': (m, p) => {
    m.blockedOrigins[p.origin] = true;
  },
  'pairing.resumed': (m, p) => {
    const r = m.pairing[p.requestId];
    if (r) Object.assign(r, { status: 'confirmed', agentId: p.agentId, codeHash: null });
  },
  'agent.paired': (m, p, e) => {
    const r = m.pairing[p.requestId];
    if (r) Object.assign(r, { status: 'confirmed', agentId: p.agentId, codeHash: null });
    m.agents[p.agentId] = {
      agentId: p.agentId,
      name: p.name,
      client: p.client,
      tags: p.tags,
      capabilities: p.capabilities,
      publicKey: p.publicKey,
      fingerprint: p.fingerprint,
      projectId: p.projectId,
      epoch: 0,
      revoked: false,
      pairedAt: e.ts,
      driven: null,
    };
  },
  'provider.saved': (m, p, e) => {
    const existing = m.providers[p.providerId];
    if (existing) existing.settings = p.settings;
    else m.providers[p.providerId] = { providerId: p.providerId, settings: p.settings, hasSecret: false, createdAt: e.ts, removed: false };
  },
  'provider.removed': (m, p) => {
    const r = m.providers[p.providerId];
    if (r) r.removed = true;
  },
  'provider.secret_changed': (m, p) => {
    const r = m.providers[p.providerId];
    if (r) r.hasSecret = p.set;
  },
  'agent.provisioned': (m, p, e) => {
    m.agents[p.agentId] = {
      agentId: p.agentId,
      name: p.name,
      client: m.providers[p.providerId]?.settings.kind ?? 'driven',
      tags: p.tags,
      capabilities: [],
      publicKey: p.publicKey,
      fingerprint: p.fingerprint,
      projectId: p.projectId,
      epoch: 0,
      revoked: false,
      pairedAt: e.ts,
      driven: { providerId: p.providerId, run: false, cliSessionId: null, sessionCostUsd: 0, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, lastTurnAt: null, lastError: null },
    };
  },
  'agent.run_requested': (m, p) => {
    const d = m.agents[p.agentId]?.driven;
    if (d) d.run = p.run;
  },
  'agent.cli_session': (m, p) => {
    const d = m.agents[p.agentId]?.driven;
    if (d) Object.assign(d, { cliSessionId: p.cliSessionId, sessionCostUsd: 0 });
  },
  'agent.turn_finished': (m, p, e) => {
    const d = m.agents[p.agentId]?.driven;
    if (!d) return;
    d.turns += 1;
    d.costUsd += p.costUsd ?? 0;
    if (p.sessionCostUsd !== null) d.sessionCostUsd = p.sessionCostUsd;
    d.inputTokens += p.inputTokens;
    d.outputTokens += p.outputTokens;
    d.lastTurnAt = e.ts;
    d.lastError = p.error;
  },
  'session.opened': (m, p) => {
    const a = m.agents[p.agentId];
    if (a) a.epoch = p.epoch;
  },
  'leader.assigned': (m, p) => {
    const project = m.projects[p.projectId];
    if (project) project.leaderId = p.agentId;
  },
  'roster.joined': (m, p, e) => {
    const project = e.projectId ? m.projects[e.projectId as keyof Model['projects']] : undefined;
    if (!project) return;
    project.roster[p.agentId] = {
      agentId: p.agentId,
      name: p.name,
      role: p.role,
      tags: p.tags,
      capabilities: p.capabilities,
      client: p.client,
      state: 'active',
      connected: false,
      epoch: 0,
      joinedAt: e.ts,
      disconnectedAt: null,
      activity: null,
    };
  },
  'roster.connected': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) Object.assign(entry, { connected: true, epoch: p.epoch, state: 'active', disconnectedAt: null });
  },
  'roster.disconnected': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) Object.assign(entry, { connected: false, disconnectedAt: e.ts });
  },
  'roster.stale': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) entry.state = 'stale';
  },
  'roster.gone': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) entry.state = 'gone';
  },
  'roster.role_changed': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) entry.role = p.role;
  },
  'human.posted': (m, p, e) => {
    const project = e.projectId ? m.projects[e.projectId as keyof Model['projects']] : undefined;
    if (project) project.humanMessages[p.messageId] = true;
  },
  'activity.reported': (m, p, e) => {
    const entry = rosterEntry(m, e, p.agentId);
    if (entry) entry.activity = { doing: p.doing, next: p.next, taskId: p.taskId, etaMinutes: p.etaMinutes, handoffNote: p.handoffNote, at: e.ts };
  },
  'repo.registered': (m, p) => {
    m.repos[p.repoId] = { repoId: p.repoId, path: p.path, mainBranch: p.mainBranch };
  },
  'project.repo_attached': (m, p) => {
    const project = m.projects[p.projectId];
    if (project) project.repoId = p.repoId;
  },
  'entry.versioned': (m, p, e) => {
    const project = projectOf(m, e);
    if (!project) return;
    const previous = project.entries[p.entryId];
    project.entries[p.entryId] = {
      entryId: p.entryId,
      section: p.section,
      version: p.version,
      author: p.author,
      via: e.via,
      createdAt: previous?.createdAt ?? e.ts,
      updatedAt: e.ts,
      supersedes: p.supersedes,
      data: p.data,
      tags: p.tags,
      criticality: p.criticality,
      changedAt: bump(project),
    };
  },
  'ticket.opened': (m, p, e) => {
    const project = projectOf(m, e);
    if (!project) return;
    project.tickets[p.ticketId] = {
      ticketId: p.ticketId,
      section: p.section,
      op: p.op,
      data: p.data,
      baseSeq: p.baseSeq,
      reason: p.reason,
      targetId: p.targetId,
      proposer: p.proposer,
      quotesHumanMessage: p.quotesHumanMessage,
      status: 'open',
      openedAt: e.ts,
    };
  },
  'ticket.committed': (m, p, e) => {
    const t = projectOf(m, e)?.tickets[p.ticketId];
    if (t) t.status = 'committed';
  },
  'ticket.rejected': (m, p, e) => {
    const t = projectOf(m, e)?.tickets[p.ticketId];
    if (t) t.status = 'rejected';
  },
  'task.created': (m, p, e) => {
    const project = projectOf(m, e);
    if (!project) return;
    project.tasks[p.taskId] = {
      taskId: p.taskId,
      title: p.title,
      criteria: p.criteria,
      status: 'proposed',
      owner: null,
      reviewer: p.reviewer,
      tester: p.tester,
      deps: p.deps,
      capabilities: p.capabilities,
      branch: null,
      changeRequestId: null,
      handoffNote: null,
      createdAt: e.ts,
      changedAt: bump(project),
    };
  },
  'task.status_changed': (m, p, e) => {
    const project = projectOf(m, e);
    const task = project?.tasks[p.taskId];
    if (!project || !task) return;
    task.status = p.to as typeof task.status;
    task.changedAt = bump(project);
  },
  'task.claimed': (m, p, e) => {
    const project = projectOf(m, e);
    const task = project?.tasks[p.taskId];
    if (!project || !task) return;
    Object.assign(task, { owner: p.owner, branch: p.branch, changedAt: bump(project) });
  },
  'task.released': (m, p, e) => {
    const project = projectOf(m, e);
    const task = project?.tasks[p.taskId];
    if (!project || !task) return;
    Object.assign(task, { owner: null, handoffNote: p.handoffNote, changedAt: bump(project) });
  },
  'change_request.opened': (m, p, e) => {
    const project = projectOf(m, e);
    if (!project) return;
    project.changeRequests[p.changeRequestId] = {
      changeRequestId: p.changeRequestId,
      taskId: p.taskId,
      repoId: p.repoId,
      branch: p.branch,
      author: p.author,
      headSha: p.headSha,
      status: 'open',
      reviews: [],
      testResults: [],
      hubRuns: [],
      mergeRequestedFor: null,
      mergeSha: null,
      openedAt: e.ts,
    };
    const task = project.tasks[p.taskId];
    if (task) Object.assign(task, { changeRequestId: p.changeRequestId, branch: p.branch });
    bump(project);
  },
  'change_request.updated': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    Object.assign(cr, { headSha: p.headSha, status: 'open' });
    bump(project);
  },
  'change_request.rebase_needed': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    cr.status = 'rebase_needed';
    bump(project);
  },
  'change_request.merged': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    cr.mergeSha = p.mergeSha;
    if (cr.headSha === p.headSha) cr.status = 'merged';
    bump(project);
  },
  'request.opened': (m, p, e) => {
    const project = projectOf(m, e);
    if (!project) return;
    project.requests[p.requestId] = {
      requestId: p.requestId,
      kind: p.kind,
      from: p.from,
      to: p.to,
      changeRequestId: p.changeRequestId,
      headSha: p.headSha,
      body: p.body,
      status: 'open',
      outcome: null,
      openedAt: e.ts,
    };
  },
  'request.closed': (m, p, e) => {
    const r = projectOf(m, e)?.requests[p.requestId];
    if (r) Object.assign(r, { status: 'closed', outcome: p.outcome });
  },
  'review.recorded': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    cr.reviews.push({ by: p.by, verdict: p.verdict, headSha: p.headSha, notes: p.notes, at: e.ts });
    bump(project);
  },
  'test.recorded': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    cr.testResults.push({ by: p.by, status: p.status, headSha: p.headSha, evidence: p.evidence, at: e.ts });
    bump(project);
  },
  'merge.requested': (m, p, e) => {
    const cr = projectOf(m, e)?.changeRequests[p.changeRequestId];
    if (cr) cr.mergeRequestedFor = p.headSha;
  },
  'quality.test_run': (m, p, e) => {
    const project = projectOf(m, e);
    const cr = project?.changeRequests[p.changeRequestId];
    if (!project || !cr) return;
    cr.hubRuns.push({ headSha: p.headSha, status: p.status, durationMs: p.durationMs, outputTail: p.outputTail, at: e.ts });
    bump(project);
  },
  'timer.scheduled': (m, p) => {
    m.timers[p.timerId] = { timerId: p.timerId, dueAt: p.dueAt, command: p.command };
  },
  'timer.cancelled': (m, p) => {
    delete m.timers[p.timerId];
  },
  'timer.fired': (m, p) => {
    delete m.timers[p.timerId];
  },
};

function projectOf(m: Model, e: PendingEvent) {
  return e.projectId ? m.projects[e.projectId as keyof Model['projects']] : undefined;
}

/** Every board change bumps the project's boardVersion (D5) and returns the new value. */
function bump(project: Model['projects'][keyof Model['projects']]): number {
  project.boardVersion += 1;
  return project.boardVersion;
}

function setPairingStatus(m: Model, requestId: string, status: 'denied' | 'expired' | 'voided') {
  const r = m.pairing[requestId as keyof Model['pairing']];
  if (r) Object.assign(r, { status, codeHash: null });
}

function rosterEntry(m: Model, e: PendingEvent, agentId: string) {
  const project = e.projectId ? m.projects[e.projectId as keyof Model['projects']] : undefined;
  return project?.roster[agentId as keyof typeof project.roster];
}

export function evolve(model: Model, event: PendingEvent | EventRow): Model {
  const fold = FOLDS[event.type as keyof EventPayloads] as Folder<keyof EventPayloads> | undefined;
  if (fold) fold(model, event.payload as never, event);
  return model;
}

/** Rebuilds a model from events: the basis of replay, snapshots and time travel. */
export function replay(events: Iterable<PendingEvent | EventRow>, from: Model): Model {
  for (const event of events) evolve(from, event);
  return from;
}
