/** Shapes of the S1 query results the app reads (the catalog's outputs are typed per slice). */
export interface ProjectSummary {
  projectId: string;
  name: string;
  createdAt: number;
  leaderId: string | null;
  agents: number;
}

export interface PairingRequest {
  requestId: string;
  name: string;
  client: string;
  tags: string[];
  capabilities: string[];
  fingerprint: string;
  origin: string;
  matchPhrase: string;
  status: 'pending' | 'allowed';
  requestedAt: number;
  expiresAt: number;
  projectId: string | null;
  codeExpiresAt: number | null;
  attempts: number;
  /** A new chat asking to continue as this paired agent (ADR-0017). */
  resumes: string | null;
}

export interface PairedAgent {
  agentId: string;
  name: string;
  client: string;
  fingerprint: string;
  projectId: string;
  role: 'worker' | 'leader' | null;
  state: string | null;
  connected: boolean;
  pairedAt: number;
}

export interface RosterRecord {
  agentId: string;
  name: string;
  role: 'worker' | 'leader';
  tags: string[];
  client: string;
  state: 'active' | 'stale' | 'gone' | 'left' | 'removed';
  connected: boolean;
  epoch: number;
  activity: { doing: string; next: string; at: number } | null;
  /** Human view only: when the agent's model last called a Round Table tool, and whether it is inside wait. */
  attention?: { lastCallAt: number; waiting: boolean; stopped: boolean } | null;
  /** Human view only: what the Round Table is telling this agent to do next. */
  next?: { tool: string; step: string } | null;
  /** Human view only: set for agents the hub runs (ADR-0018). */
  driven?: DrivenInfo | null;
}

export interface LogEvent {
  gpos: number;
  sseq: number;
  type: string;
  actor: string;
  role: string;
  via: string;
  ts: number;
  payload: Record<string, unknown>;
}

export type RunStatus = 'starting' | 'working' | 'idle' | 'stopped' | 'crashed';

export interface LiveState {
  status: RunStatus;
  since: number;
  lastError: string | null;
  tool: string | null;
}

/** Human view of a hub-run agent (ADR-0018), on roster records. */
export interface DrivenInfo {
  providerId: string;
  /** The provider's CLI kind (for its logo). */
  kind: string | null;
  /** The agent's own model and effort; empty: the provider's or its role's default. */
  model: string;
  effort: string;
  run: boolean;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastTurnAt: number | null;
  live: LiveState;
}

export interface ProviderKindDef {
  kind: string;
  label: string;
  binary: string;
  apiKeyEnv: string;
  login: string;
  install: string;
  driverVerified: boolean;
  models: readonly string[];
  listModels?: readonly string[];
  efforts: readonly string[];
  dynamicTools: boolean;
  envHints: readonly string[];
}

export interface ProviderSettings {
  kind: string;
  label: string;
  command: string;
  auth: 'cli-login' | 'api-key';
  model: string;
  effort: string;
  extraArgs: string[];
  maxInstances: number;
  env: Array<{ name: string; value: string }>;
  secretEnv: string[];
}

export interface ProviderRecord {
  providerId: string;
  settings: ProviderSettings;
  hasSecret: boolean;
  secretsSet: string[];
  createdAt: number;
  running: number;
  agents: Array<{ agentId: string; name: string; projectId: string; run: boolean; costUsd: number; live: LiveState | null }>;
}

export interface ProviderList {
  kinds: ProviderKindDef[];
  canRun: boolean;
  providers: ProviderRecord[];
}

export interface TranscriptEntry {
  id: number;
  at: number;
  kind: 'to_agent' | 'thinking' | 'text' | 'tool' | 'tool_result' | 'turn' | 'status';
  text: string;
  data: Record<string, unknown> | null;
}
