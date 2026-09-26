import type { AgentId, ChangeRequestId, Criticality, EntryId, PairingId, ProjectId, ProviderId, ProviderSettings, RepoId, RequestId, Sha, TaskId, TicketId } from '@round-table/protocol';
import type { TaskStatus } from './tasks/status.ts';

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
  repos: Record<RepoId, RepoRecord>;
  timers: Record<string, TimerRecord>;
  /** Configured CLIs agents are started from (ADR-0018). */
  providers: Record<ProviderId, ProviderRecord>;
}

export interface ProviderRecord {
  providerId: ProviderId;
  settings: ProviderSettings;
  /** The hub holds a credential for it (the value lives outside the log). */
  hasSecret: boolean;
  /** Secret environment variables that have a value (names only). */
  secretsSet: string[];
  createdAt: number;
  removed: boolean;
}

/** A hub-run agent (ADR-0018): what the supervisor needs to start, resume and account for it. */
export interface DrivenAgent {
  providerId: ProviderId;
  /** The human's wish; the supervisor follows it, also after hub restarts. */
  run: boolean;
  cliSessionId: string | null;
  /** The CLI's running cost total for the current session (it reports cumulative totals). */
  sessionCostUsd: number;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastTurnAt: number | null;
  lastError: string | null;
}

export interface RepoRecord {
  repoId: RepoId;
  path: string;
  mainBranch: string;
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
  /** A new chat asking to continue as this existing agent (ADR-0017). */
  resumes: AgentId | null;
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
  /** Set for agents the hub runs; null for agents that paired from their own session. */
  driven: DrivenAgent | null;
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
  repoId: RepoId | null;
  /** Bumped by every board change; proposals carry the value they saw as `baseSeq` (D5). */
  boardVersion: number;
  entries: Record<EntryId, EntryRecord>;
  tickets: Record<TicketId, TicketRecord>;
  tasks: Record<TaskId, TaskRecord>;
  changeRequests: Record<ChangeRequestId, ChangeRequestRecord>;
  requests: Record<RequestId, RequestRecord>;
}

/** Latest version of a document-section entry; older versions live in the log (board_history). */
export interface EntryRecord {
  entryId: EntryId;
  section: string;
  version: number;
  author: string;
  via: 'hub' | 'leader' | 'human';
  createdAt: number;
  updatedAt: number;
  supersedes: string | null;
  data: unknown;
  tags: string[];
  criticality: Criticality;
  /** boardVersion when this version was written (D5 staleness check). */
  changedAt: number;
}

export interface TicketRecord {
  ticketId: TicketId;
  section: string;
  op: string;
  data: unknown;
  baseSeq: number;
  reason: string;
  targetId: string | null;
  proposer: AgentId;
  quotesHumanMessage: string | null;
  status: 'open' | 'committed' | 'rejected';
  openedAt: number;
}

export interface TaskRecord {
  taskId: TaskId;
  title: string;
  criteria: string[];
  status: TaskStatus;
  owner: AgentId | null;
  reviewer: AgentId | null;
  tester: AgentId | null;
  deps: TaskId[];
  capabilities: string[];
  branch: string | null;
  changeRequestId: ChangeRequestId | null;
  handoffNote: string | null;
  createdAt: number;
  changedAt: number;
}

export interface ChangeRequestRecord {
  changeRequestId: ChangeRequestId;
  taskId: TaskId;
  repoId: RepoId;
  branch: string;
  author: AgentId;
  headSha: Sha;
  status: 'open' | 'merged' | 'rebase_needed';
  reviews: Array<{ by: AgentId; verdict: 'approved' | 'changes_needed'; headSha: Sha; notes: string; at: number }>;
  testResults: Array<{ by: AgentId; status: 'pass' | 'fail'; headSha: Sha; evidence: string; at: number }>;
  hubRuns: Array<{ headSha: Sha; status: 'pass' | 'fail' | 'timeout' | 'error' | 'conflict'; durationMs: number; outputTail: string; at: number }>;
  /** Head sha a merge was already requested for, so it is requested once per head. */
  mergeRequestedFor: Sha | null;
  mergeSha: Sha | null;
  openedAt: number;
}

export interface RequestRecord {
  requestId: RequestId;
  kind: 'review' | 'test';
  from: AgentId;
  to: AgentId;
  changeRequestId: ChangeRequestId;
  headSha: Sha;
  body: string | null;
  status: 'open' | 'closed';
  outcome: string | null;
  openedAt: number;
}

export interface TimerRecord {
  timerId: string;
  dueAt: number;
  command: { name: string; input: unknown };
}

export function initialModel(): Model {
  return { pairing: {}, blockedOrigins: {}, agents: {}, projects: {}, repos: {}, timers: {}, providers: {} };
}
