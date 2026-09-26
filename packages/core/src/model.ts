import type { AgentId, PairingId, ProjectId } from '@round-table/protocol';

/**
 * The in-memory write model: everything `decide` needs to check a command. It is plain JSON
 * (records, not Maps) so a snapshot is `JSON.stringify(model)` (ADR-0006). Only `evolve`
 * changes it.
 */
export interface Model {
  pairing: Record<PairingId, PairingRecord>;
  blockedOrigins: Record<string, true>;
  agents: Record<AgentId, AgentRecord>;
  projects: Record<ProjectId, ProjectRecord>;
  timers: Record<string, TimerRecord>;
}

export type PairingStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'voided' | 'confirmed';

export interface PairingRecord {
  requestId: PairingId;
  name: string;
  client: string;
  tags: string[];
  capabilities: string[];
  publicKey: string;
  fingerprint: string;
  origin: string;
  matchPhrase: string;
  status: PairingStatus;
  requestedAt: number;
  expiresAt: number;
  projectId: ProjectId | null;
  codeHash: string | null;
  codeExpiresAt: number | null;
  attempts: number;
  agentId: AgentId | null;
}

export interface AgentRecord {
  agentId: AgentId;
  name: string;
  client: string;
  tags: string[];
  capabilities: string[];
  publicKey: string;
  fingerprint: string;
  projectId: ProjectId;
  epoch: number;
  revoked: boolean;
  pairedAt: number;
}

export type RosterState = 'active' | 'stale' | 'gone' | 'left' | 'removed';

export interface RosterEntry {
  agentId: AgentId;
  name: string;
  role: 'worker' | 'leader';
  tags: string[];
  capabilities: string[];
  client: string;
  state: RosterState;
  connected: boolean;
  epoch: number;
  joinedAt: number;
  disconnectedAt: number | null;
  activity: { doing: string; next: string; taskId: string | null; etaMinutes: number | null; handoffNote: string | null; at: number } | null;
}

export interface ProjectRecord {
  projectId: ProjectId;
  name: string;
  createdAt: number;
  leaderId: AgentId | null;
  roster: Record<AgentId, RosterEntry>;
  /** Human message ids, so "the human said" quotes can be verified (F6). */
  humanMessages: Record<string, true>;
}

export interface TimerRecord {
  timerId: string;
  dueAt: number;
  command: { name: string; input: unknown };
}

export function initialModel(): Model {
  return { pairing: {}, blockedOrigins: {}, agents: {}, projects: {}, timers: {} };
}
