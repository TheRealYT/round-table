import { priorityRank, type Priority } from '@round-table/protocol';

/**
 * Pending `wait` calls (ADR-0001). A wait resolves at once for human or critical deliveries,
 * after a short coalescing window for direct and normal ones (so a burst arrives together),
 * and otherwise on timeout. Digest items never wake a waiter early.
 */
export class Waiters {
  private readonly pending = new Map<string, Set<Waiter>>();
  private readonly coalesceMs: number;

  constructor(options: { coalesceMs: number }) {
    this.coalesceMs = options.coalesceMs;
  }

  wait(agentId: string, timeoutMs: number): Promise<'woken' | 'timeout' | 'cancelled'> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (reason) => {
          clearTimeout(waiter.timeout);
          if (waiter.coalesce) clearTimeout(waiter.coalesce);
          this.pending.get(agentId)?.delete(waiter);
          resolve(reason);
        },
        timeout: setTimeout(() => waiter.resolve('timeout'), timeoutMs),
      };
      let set = this.pending.get(agentId);
      if (!set) this.pending.set(agentId, (set = new Set()));
      set.add(waiter);
    });
  }

  notify(agentId: string, priority: Priority): void {
    for (const waiter of this.pending.get(agentId) ?? []) {
      if (priorityRank(priority) <= priorityRank('critical')) waiter.resolve('woken');
      else if (priority !== 'digest' && !waiter.coalesce) waiter.coalesce = setTimeout(() => waiter.resolve('woken'), this.coalesceMs);
    }
  }

  /** Ends every wait for an agent (session closed or fenced). */
  cancel(agentId: string): void {
    for (const waiter of this.pending.get(agentId) ?? []) waiter.resolve('cancelled');
  }

  cancelAll(): void {
    for (const agentId of this.pending.keys()) this.cancel(agentId);
  }
}

interface Waiter {
  resolve(reason: 'woken' | 'timeout' | 'cancelled'): void;
  timeout: ReturnType<typeof setTimeout>;
  coalesce?: ReturnType<typeof setTimeout>;
}
