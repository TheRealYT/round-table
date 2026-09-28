import type { AgentId, ChangeRequestId, EntryId, PairingId, ProjectId, ProviderId, RepoId, RequestId, Sha, TaskId, TicketId } from './ids.ts';
import type { ProviderSettings } from './providers.ts';
import type { SettingsOverrides } from './settings.ts';
import type { Criticality } from './entry.ts';
import type { Refs } from './event.ts';
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
    /** Set when the key is already paired: a new chat asks to continue as that agent (ADR-0017). */
    resumes?: AgentId;
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
  /** The human approved a new chat continuing as an existing agent (ADR-0017). */
  'pairing.resumed': { requestId: PairingId; agentId: AgentId; projectId: ProjectId };
  // ── providers and driven agents (ADR-0018) ──
  'provider.saved': { providerId: ProviderId; settings: ProviderSettings };
  'provider.removed': { providerId: ProviderId };
  /** A credential was stored or cleared by the hub; the value itself never enters the log. */
  'provider.secret_changed': { providerId: ProviderId; set: boolean; /** null: the API key; else a secret env var. */ name?: string | null };
  /** The hub started an agent from a provider: it issued the identity itself (no pairing). */
  'agent.provisioned': { agentId: AgentId; projectId: ProjectId; providerId: ProviderId; name: string; tags: string[]; publicKey: string; fingerprint: string; /** Overrides of the provider's model and effort; empty: the provider's. */ model?: string; effort?: string };
  /** The human changed a hub-run agent's model or effort (empty: the provider's); applied at its next idle moment. */
  'agent.configured': { agentId: AgentId; model: string; effort: string };
  /** The human wants the agent running or stopped; the supervisor follows it, also after restarts. */
  'agent.run_requested': { agentId: AgentId; run: boolean };
  /** The CLI's own session id, so a restarted process resumes the same conversation. */
  'agent.cli_session': { agentId: AgentId; cliSessionId: string };
  /** One finished turn, as the CLI reported it. */
  'agent.turn_finished': { agentId: AgentId; ok: boolean; durationMs: number; costUsd: number | null; sessionCostUsd: number | null; inputTokens: number; outputTokens: number; error: string | null };
  'session.opened': { agentId: AgentId; projectId: ProjectId; epoch: number };
  'leader.assigned': { projectId: ProjectId; agentId: AgentId; previous: AgentId | null };
  /** The human set a scope's settings: the whole override object for the hub, or for one project. */
  'settings.changed': { scope: 'hub' | 'project'; projectId: ProjectId | null; overrides: SettingsOverrides };
  /** The project's hub-run agents spent 80% of its budget. */
  'budget.warned': { projectId: ProjectId; costUsd: number; limitUsd: number };
  /** The project's hub-run agents reached its budget: the hub stopped them. */
  'budget.reached': { projectId: ProjectId; costUsd: number; limitUsd: number };
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
  'repo.registered': { repoId: RepoId; path: string; mainBranch: string };
  'project.repo_attached': { projectId: ProjectId; repoId: RepoId };
  // ── board (project stream) ──
  'entry.versioned': {
    entryId: EntryId;
    section: string;
    version: number;
    supersedes: string | null;
    author: string;
    data: unknown;
    tags: string[];
    criticality: Criticality;
    ticketId: TicketId | null;
    refs: Refs;
  };
  'ticket.opened': {
    ticketId: TicketId;
    section: string;
    op: string;
    data: unknown;
    baseSeq: number;
    reason: string;
    targetId: string | null;
    proposer: AgentId;
    quotesHumanMessage: string | null;
  };
  'ticket.committed': { ticketId: TicketId; by: AgentId; result: string };
  'ticket.rejected': { ticketId: TicketId; by: string; reason: string; stale: boolean };
  'task.created': {
    taskId: TaskId;
    title: string;
    criteria: string[];
    reviewer: AgentId | null;
    tester: AgentId | null;
    deps: TaskId[];
    capabilities: string[];
    ticketId: TicketId | null;
    proposer: string;
  };
  'task.status_changed': { taskId: TaskId; from: string; to: string; cause: 'hub_rule' | 'done_rule' | 'human' | 'leader'; reason: string };
  'task.claimed': { taskId: TaskId; owner: AgentId; branch: string };
  'task.released': { taskId: TaskId; owner: AgentId; handoffNote: string | null };
  'change_request.opened': { changeRequestId: ChangeRequestId; taskId: TaskId; repoId: RepoId; branch: string; headSha: Sha; author: AgentId };
  'change_request.updated': { changeRequestId: ChangeRequestId; headSha: Sha; previous: Sha };
  'change_request.rebase_needed': { changeRequestId: ChangeRequestId; headSha: Sha; files: string[] };
  'change_request.merged': { changeRequestId: ChangeRequestId; headSha: Sha; mergeSha: Sha; baseSha: Sha };
  'request.opened': { requestId: RequestId; kind: 'review' | 'test'; from: AgentId; to: AgentId; changeRequestId: ChangeRequestId; headSha: Sha; body: string | null };
  'request.closed': { requestId: RequestId; outcome: string; by: AgentId };
  'review.recorded': { changeRequestId: ChangeRequestId; by: AgentId; verdict: 'approved' | 'changes_needed'; headSha: Sha; notes: string };
  'test.recorded': { changeRequestId: ChangeRequestId; by: AgentId; status: 'pass' | 'fail'; headSha: Sha; evidence: string };
  'merge.requested': { changeRequestId: ChangeRequestId; headSha: Sha; repoId: RepoId; testCommand: string; testTimeoutSec: number };
  'quality.test_run': {
    changeRequestId: ChangeRequestId;
    headSha: Sha;
    status: 'pass' | 'fail' | 'timeout' | 'error' | 'conflict';
    durationMs: number;
    outputTail: string;
    mergeSha: Sha | null;
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
  'pairing.resumed': 'durable',
  'session.opened': 'durable',
  'provider.saved': 'durable',
  'provider.removed': 'durable',
  'provider.secret_changed': 'durable',
  'agent.provisioned': 'durable',
  'agent.run_requested': 'durable',
  'agent.configured': 'durable',
  'agent.cli_session': 'durable',
  'agent.turn_finished': 'durable',
  'leader.assigned': 'durable',
  'settings.changed': 'durable',
  'budget.warned': 'durable',
  'budget.reached': 'durable',
  'roster.joined': 'durable',
  'roster.connected': 'ephemeral',
  'roster.disconnected': 'ephemeral',
  'roster.stale': 'durable',
  'roster.gone': 'durable',
  'roster.role_changed': 'durable',
  'message.sent': 'ephemeral',
  'human.posted': 'durable',
  'activity.reported': 'ephemeral',
  'repo.registered': 'durable',
  'project.repo_attached': 'durable',
  'entry.versioned': 'durable',
  'ticket.opened': 'durable',
  'ticket.committed': 'durable',
  'ticket.rejected': 'durable',
  'task.created': 'durable',
  'task.status_changed': 'durable',
  'task.claimed': 'durable',
  'task.released': 'durable',
  'change_request.opened': 'durable',
  'change_request.updated': 'durable',
  'change_request.rebase_needed': 'durable',
  'change_request.merged': 'durable',
  'request.opened': 'durable',
  'request.closed': 'durable',
  'review.recorded': 'durable',
  'test.recorded': 'durable',
  'merge.requested': 'durable',
  'quality.test_run': 'durable',
  'timer.scheduled': 'durable',
  'timer.cancelled': 'durable',
  'timer.fired': 'durable',
};
