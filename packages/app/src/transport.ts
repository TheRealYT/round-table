import { decodeFrame, encodeFrame, Handlers, type Frame, type Transport } from '@round-table/protocol';

/** Transport over the browser's WebSocket (web APIs only, so Electron can wrap it later). */
export class BrowserWsTransport implements Transport {
  private readonly socket: WebSocket;
  private readonly frames = new Handlers<Frame>();
  private readonly closes = new Handlers<string>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (e) => {
      try {
        this.frames.emit(decodeFrame(String(e.data)));
      } catch {
        // A malformed frame from the hub is a bug; drop it rather than crash the app.
      }
    });
    socket.addEventListener('close', (e) => this.closes.emit(e.reason || 'closed'));
  }

  /** Connects to the hub that served this page; the login cookie rides along. */
  static connect(): Promise<BrowserWsTransport> {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/app`);
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(new BrowserWsTransport(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('cannot reach the hub')), { once: true });
    });
  }

  get state(): 'open' | 'closed' {
    return this.socket.readyState === WebSocket.OPEN ? 'open' : 'closed';
  }

  send(frame: Frame): void {
    this.socket.send(encodeFrame(frame));
  }

  onFrame(handler: (frame: Frame) => void): () => void {
    return this.frames.add(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    return this.closes.add(handler);
  }

  close(reason = 'closed'): void {
    this.socket.close(1000, reason);
  }
}
