import { PROTOCOL_VERSION, type ErrorCode, type Frame } from './frame.ts';
import type { Transport } from './transport.ts';

export class HubError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.details = details;
  }
  /** The domain code of a `rejected` error, e.g. `already_claimed`. */
  get rejection(): string | undefined {
    const d = this.details as { code?: unknown } | undefined;
    return this.code === 'rejected' && typeof d?.code === 'string' ? d.code : undefined;
  }
}

/** Request/response and pushed events over one Transport. Used by rt-agent, the human app and tests. */
export class HubClient {
  private readonly transport: Transport;
  private readonly pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly topics = new Map<string, Set<(data: unknown) => void>>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private counter = 0;
  epoch: number | undefined;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onFrame((frame) => this.receive(frame));
    transport.onClose((reason) => {
      for (const p of this.pending.values()) p.reject(new HubError('internal', `connection closed: ${reason}`));
      this.pending.clear();
      for (const h of this.closeHandlers) h(reason);
    });
  }

  get open(): boolean {
    return this.transport.state === 'open';
  }

  call<T = unknown>(proc: string, input: unknown = {}): Promise<T> {
    const id = `r${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        const payload = this.epoch === undefined ? { proc, input } : { proc, input, epoch: this.epoch };
        this.transport.send({ v: PROTOCOL_VERSION, id, type: 'req', payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(topic: string, handler: (data: unknown) => void): () => void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(reason?: string): void {
    this.transport.close(reason);
  }

  private receive(frame: Frame): void {
    if (frame.type === 'evt') {
      for (const h of this.topics.get(frame.payload.topic) ?? []) h(frame.payload.data);
      return;
    }
    const waiting = this.pending.get(frame.id);
    if (!waiting) return;
    this.pending.delete(frame.id);
    if (frame.type === 'res') waiting.resolve(frame.payload.output);
    else if (frame.type === 'err') waiting.reject(new HubError(frame.payload.code, frame.payload.message, frame.payload.details));
  }
}
