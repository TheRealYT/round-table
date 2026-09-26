import { decodeFrame, encodeFrame, type Frame } from './frame.ts';
import {
  Handlers,
  type ConnectionInfo,
  type Transport,
  type TransportConnector,
  type TransportListener,
} from './transport.ts';

/**
 * In-process transport for tests. Frames are encoded and decoded on the way through, so
 * anything that would not survive the real wire (non-JSON values, bad shapes) fails here too.
 * Delivery is asynchronous and in order, like a socket.
 */
class MemoryEnd implements Transport {
  state: 'open' | 'closed' = 'open';
  peer: MemoryEnd | undefined;
  readonly frames = new Handlers<Frame>();
  readonly closes = new Handlers<string>();

  send(frame: Frame): void {
    if (this.state === 'closed') throw new Error('transport is closed');
    const text = encodeFrame(frame);
    const peer = this.peer;
    void Promise.resolve().then(() => {
      if (peer?.state === 'open') peer.frames.emit(decodeFrame(text));
    });
  }

  onFrame(handler: (frame: Frame) => void): () => void {
    return this.frames.add(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    return this.closes.add(handler);
  }

  close(reason = 'closed'): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const peer = this.peer;
    void Promise.resolve().then(() => {
      this.closes.emit(reason);
      this.frames.clear();
      if (peer && peer.state === 'open') peer.close(reason);
    });
  }
}

/** Two connected ends. */
export function createMemoryPair(): [Transport, Transport] {
  const a = new MemoryEnd();
  const b = new MemoryEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A connector and listener joined in memory: what a scenario test uses instead of a socket. */
export class MemoryNetwork implements TransportConnector, TransportListener {
  private readonly connections = new Handlers<{ transport: Transport; info: ConnectionInfo }>();
  private readonly open = new Set<Transport>();

  private readonly remoteAddress: string;

  constructor(remoteAddress = 'memory') {
    this.remoteAddress = remoteAddress;
  }

  /** `extra` stands in for what a socket would carry (e.g. the human's login cookie). */
  async connect(endpoint: ConnectionInfo['endpoint'], extra: Partial<Omit<ConnectionInfo, 'endpoint'>> = {}): Promise<Transport> {
    const [client, server] = createMemoryPair();
    this.open.add(server);
    server.onClose(() => this.open.delete(server));
    this.connections.emit({ transport: server, info: { remoteAddress: this.remoteAddress, ...extra, endpoint } });
    return client;
  }

  onConnection(handler: (transport: Transport, info: ConnectionInfo) => void): () => void {
    return this.connections.add(({ transport, info }) => handler(transport, info));
  }

  async close(): Promise<void> {
    for (const transport of this.open) transport.close('listener closed');
    this.open.clear();
  }
}
