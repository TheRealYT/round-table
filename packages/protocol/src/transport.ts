import type { Frame } from './frame.ts';

/**
 * The only way anything above the wire talks to a peer (spec: Transport layer).
 * Implementations: MemoryTransport (tests), WsTransport (local WebSocket). An encrypted
 * transport later is one more implementation; nothing above this interface changes.
 */
export interface Transport {
  readonly state: 'open' | 'closed';
  send(frame: Frame): void;
  /** Registers a frame handler; returns an unsubscribe function. */
  onFrame(handler: (frame: Frame) => void): () => void;
  /** Called once when either side closes or the connection drops. */
  onClose(handler: (reason: string) => void): () => void;
  close(reason?: string): void;
}

/** What the hub's gateway learns about a new connection before any frame arrives. */
export interface ConnectionInfo {
  /** `/agent` sessions can only become agent principals; `/app` sessions only the human. */
  endpoint: 'agent' | 'app';
  remoteAddress: string;
  /** Origin and Host headers, when the transport has them (WebSocket upgrade). Used for DNS-rebinding checks. */
  origin?: string;
  host?: string;
  cookie?: string;
}

/** Client side: opens a connection to the hub. */
export interface TransportConnector {
  connect(endpoint: ConnectionInfo['endpoint']): Promise<Transport>;
}

/** Hub side: accepts connections. */
export interface TransportListener {
  onConnection(handler: (transport: Transport, info: ConnectionInfo) => void): () => void;
  close(): Promise<void>;
}

/** Shared plumbing for handler lists so implementations stay small. */
export class Handlers<T> {
  private readonly list = new Set<(value: T) => void>();
  add(handler: (value: T) => void): () => void {
    this.list.add(handler);
    return () => this.list.delete(handler);
  }
  emit(value: T): void {
    for (const handler of [...this.list]) handler(value);
  }
  clear(): void {
    this.list.clear();
  }
}
