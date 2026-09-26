import type { ConnectionInfo, Principal, Transport } from '@round-table/protocol';

/** One live connection and who it is. The principal changes on authentication and role changes. */
export interface Session {
  readonly id: number;
  readonly transport: Transport;
  readonly info: ConnectionInfo;
  principal: Principal;
  /** Set when a newer session proved the same key (ADR-0004); every later frame gets `fenced`. */
  fenced: boolean;
}

export function agentOf(session: Session): { agentId: string; projectId: string; epoch: number } | undefined {
  const p = session.principal;
  return p.kind === 'worker' || p.kind === 'leader' ? { agentId: p.agentId, projectId: p.projectId, epoch: p.epoch } : undefined;
}

export class RpcError extends Error {
  readonly code: import('@round-table/protocol').ErrorCode;
  readonly details: unknown;
  constructor(code: import('@round-table/protocol').ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}
