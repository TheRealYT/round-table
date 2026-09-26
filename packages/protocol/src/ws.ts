import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, ProtocolError, type Frame } from './frame.ts';
import {
  Handlers,
  type ConnectionInfo,
  type Transport,
  type TransportConnector,
  type TransportListener,
} from './transport.ts';

/**
 * Local WebSocket transport (Node only; import from `@round-table/protocol/ws`).
 * The hub listens on 127.0.0.1 only. Paths map to endpoints: `/agent` and `/app`.
 */
class WsTransport implements Transport {
  private readonly frames = new Handlers<Frame>();
  private readonly closes = new Handlers<string>();

  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: RawData) => this.receive(data));
    socket.on('close', (_code, reason) => {
      this.closes.emit(reason.toString() || 'closed');
      this.frames.clear();
    });
    socket.on('error', () => socket.terminate());
  }

  get state(): 'open' | 'closed' {
    return this.socket.readyState === WebSocket.OPEN ? 'open' : 'closed';
  }

  send(frame: Frame): void {
    if (this.state === 'closed') throw new Error('transport is closed');
    this.socket.send(encodeFrame(frame));
  }

  onFrame(handler: (frame: Frame) => void): () => void {
    return this.frames.add(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    return this.closes.add(handler);
  }

  close(reason = 'closed'): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, reason);
    }
  }

  private receive(data: RawData): void {
    try {
      this.frames.emit(decodeFrame(data.toString()));
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : 'bad_frame';
      const message = error instanceof Error ? error.message : 'bad frame';
      this.socket.send(encodeFrame({ v: PROTOCOL_VERSION, id: '-', type: 'err', payload: { code, message } }));
    }
  }
}

const ENDPOINTS = { '/agent': 'agent', '/app': 'app' } as const;
/** Transport-level heartbeat (ADR-0002): a peer that misses a pong is dropped, which starts the stale timer. */
const PING_INTERVAL_MS = 15_000;

export class WsListener implements TransportListener {
  private readonly connections = new Handlers<{ transport: Transport; info: ConnectionInfo }>();
  private readonly server: WebSocketServer;
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on('connection', (socket: WebSocket, request: IncomingMessage) => this.accept(socket, request));
    this.heartbeat = setInterval(() => {
      for (const client of this.server.clients) {
        if (this.alive.get(client) === false) {
          client.terminate();
          continue;
        }
        this.alive.set(client, false);
        client.ping();
      }
    }, PING_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  /** Binds its own server to 127.0.0.1 only (spec: no network exposure). Port 0 picks a free port. */
  static async listen(port: number): Promise<WsListener> {
    const server = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return new WsListener(server);
  }

  /** Shares an HTTP server (the hub serves the app and WebSockets on one port). */
  static attach(httpServer: HttpServer): WsListener {
    const server = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!(path in ENDPOINTS)) {
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (ws) => server.emit('connection', ws, request));
    });
    return new WsListener(server);
  }

  get port(): number {
    const address = this.server.address();
    if (typeof address === 'string' || address === null) throw new Error('listener has no port');
    return address.port;
  }

  onConnection(handler: (transport: Transport, info: ConnectionInfo) => void): () => void {
    return this.connections.add(({ transport, info }) => handler(transport, info));
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const endpoint = ENDPOINTS[path as keyof typeof ENDPOINTS];
    if (!endpoint) {
      socket.close(1008, 'unknown endpoint');
      return;
    }
    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
    const info: ConnectionInfo = {
      endpoint,
      remoteAddress: request.socket.remoteAddress ?? 'unknown',
      ...(request.headers.origin !== undefined && { origin: request.headers.origin }),
      ...(request.headers.host !== undefined && { host: request.headers.host }),
      ...(request.headers.cookie !== undefined && { cookie: request.headers.cookie }),
    };
    this.connections.emit({ transport: new WsTransport(socket), info });
  }
}

export class WsConnector implements TransportConnector {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  /** `headers` lets Node clients present what a browser would (e.g. the human's login cookie in tests). */
  constructor(baseUrl: string, options: { headers?: Record<string, string> } = {}) {
    this.baseUrl = baseUrl;
    this.headers = options.headers ?? {};
  }

  async connect(endpoint: ConnectionInfo['endpoint']): Promise<Transport> {
    const socket = new WebSocket(`${this.baseUrl}/${endpoint}`, { headers: this.headers });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new WsTransport(socket);
  }
}
