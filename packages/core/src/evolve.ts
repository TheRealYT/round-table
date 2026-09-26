import type { EventPayloads, EventRow, PendingEvent } from '@round-table/protocol';
import type { Model } from './model.ts';

type Folder<T extends keyof EventPayloads> = (model: Model, payload: EventPayloads[T], event: PendingEvent) => void;

/**
 * Folds events into the model, in place. Deterministic and total: it never throws on an event
 * `decide` produced, and it reads nothing but the model and the event (so replay is exact).
 */
const FOLDS: { [K in keyof EventPayloads]?: Folder<K> } = {
  'project.created': (m, p, e) => {
    m.projects[p.projectId] = { projectId: p.projectId, name: p.name, createdAt: e.ts, leaderId: null, roster: {}, humanMessages: {} };
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
    };
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
