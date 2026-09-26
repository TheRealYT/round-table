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
