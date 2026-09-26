import type { AgentId, PairingId, ProjectId } from './ids.ts';
import type { MessageType, Priority } from './message.ts';
import type { Durability } from './event.ts';

/**
 * The event catalog: every event type, its durability (ADR-0006) and its payload shape.
 * Core produces them, projectors and the app read them. Slices add entries here.
 */
export interface EventPayloads {
  // ── system stream ──
  'project.created': { projectId: ProjectId; name: string };
  'pairing.requested': {
    requestId: PairingId;
    name: string;
    client: string;
    tags: string[];
    capabilities: string[];
    publicKey: string;
    fingerprint: string;
    origin: string;
    matchPhrase: string;
    expiresAt: number;
  };
  'pairing.allowed': { requestId: PairingId; projectId: ProjectId; codeHash: string; codeExpiresAt: number };
  'pairing.denied': { requestId: PairingId };
  'pairing.code_failed': { requestId: PairingId; attempts: number };
  'pairing.voided': { requestId: PairingId; reason: 'too_many_attempts' | 'code_expired' };
  'pairing.expired': { requestId: PairingId };
  'pairing.origin_blocked': { origin: string };
  'agent.paired': {
    agentId: AgentId;
    requestId: PairingId;
    projectId: ProjectId;
    name: string;
    client: string;
    tags: string[];
    capabilities: string[];
    publicKey: string;
    fingerprint: string;
  };
  'session.opened': { agentId: AgentId; projectId: ProjectId; epoch: number };
  'leader.assigned': { projectId: ProjectId; agentId: AgentId; previous: AgentId | null };
  // ── project stream ──
  'roster.joined': { agentId: AgentId; name: string; role: 'worker' | 'leader'; tags: string[]; capabilities: string[]; client: string };
  'roster.connected': { agentId: AgentId; epoch: number };
  'roster.disconnected': { agentId: AgentId; epoch: number };
  'roster.stale': { agentId: AgentId };
  'roster.gone': { agentId: AgentId };
  'roster.role_changed': { agentId: AgentId; role: 'worker' | 'leader' };
  'message.sent': MessagePayload;
  'human.posted': MessagePayload;
  'activity.reported': {
    agentId: AgentId;
    doing: string;
    next: string;
    taskId: string | null;
    etaMinutes: number | null;
    handoffNote: string | null;
  };
  // ── any stream ──
  'timer.scheduled': { timerId: string; dueAt: number; command: { name: string; input: unknown } };
  'timer.cancelled': { timerId: string };
  'timer.fired': { timerId: string };
}

/** What `message.sent` and `human.posted` carry. Recipients are resolved in core, so delivery replays exactly. */
export interface MessagePayload {
  messageId: string;
  from: string;
  role: 'human' | 'leader' | 'worker' | 'hub';
  to: 'all' | string | string[];
  channel: string | null;
  type: MessageType;
  priority: Priority;
  ref: string | null;
  body: string;
  recipients: AgentId[];
  quotesHumanMessage: string | null;
}

export type EventType = keyof EventPayloads;

export const EVENT_DURABILITY: { [K in EventType]: Durability } = {
  'project.created': 'durable',
  'pairing.requested': 'durable',
  'pairing.allowed': 'durable',
  'pairing.denied': 'durable',
  'pairing.code_failed': 'durable',
  'pairing.voided': 'durable',
  'pairing.expired': 'durable',
  'pairing.origin_blocked': 'durable',
  'agent.paired': 'durable',
  'session.opened': 'durable',
  'leader.assigned': 'durable',
  'roster.joined': 'durable',
  'roster.connected': 'ephemeral',
  'roster.disconnected': 'ephemeral',
  'roster.stale': 'durable',
  'roster.gone': 'durable',
  'roster.role_changed': 'durable',
  'message.sent': 'ephemeral',
  'human.posted': 'durable',
  'activity.reported': 'ephemeral',
  'timer.scheduled': 'durable',
  'timer.cancelled': 'durable',
  'timer.fired': 'durable',
};
