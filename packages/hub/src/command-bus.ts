import { COMMANDS, evolve, HUB, makeEvent, type Ctx, type Model } from '@round-table/core';
import type { EventRow, PendingEvent, Principal } from '@round-table/protocol';
import type { CommandBus, CommandResult } from './bus.ts';
import type { EventStore } from './store.ts';

export type CommitListener = (rows: EventRow[]) => void;

/**
 * The single writer (ADR-0005). Everything here is synchronous: `decide`, the SQLite
 * transaction and `evolve` run to completion before the next command, so there are no
 * interleavings to reason about. IO never runs here; reactors do it after commit.
 */
export class Bus implements CommandBus {
  private readonly store: EventStore;
  private readonly model: Model;
  private readonly ctx: () => Ctx;
  private readonly listeners: CommitListener[] = [];
  private closed = false;

  constructor(options: { store: EventStore; model: Model; ctx: () => Ctx }) {
    this.store = options.store;
    this.model = options.model;
    this.ctx = options.ctx;
  }

  onCommit(listener: CommitListener): void {
    this.listeners.push(listener);
  }

  /** After close, nothing is written: late socket closes during shutdown must not touch a closed store. */
  close(): void {
    this.closed = true;
  }

  dispatch(name: string, input: unknown, principal: Principal, options: { timerId?: string } = {}): CommandResult {
    if (this.closed) return { ok: false, rejection: { code: 'hub_closed', message: 'the hub is shutting down' }, events: [] };
    const handler = COMMANDS[name];
    if (!handler) {
      return { ok: false, rejection: { code: 'unknown_command', message: `no command "${name}"` }, events: [] };
    }
    const ctx = this.ctx();
    let decision;
    try {
      decision = handler(this.model, { name, input, principal }, ctx);
    } catch (error) {
      // A bug in one command must not take the hub down; nothing was written.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, rejection: { code: 'internal', message: `command ${name} failed: ${message}` }, events: [] };
    }
    const pending: PendingEvent[] = [...decision.events];
    if (options.timerId !== undefined) {
      pending.push(makeEvent(ctx, HUB, { stream: 'system', projectId: null }, 'timer.fired', { timerId: options.timerId }));
    }
    const rows = pending.length === 0 ? [] : this.store.transaction((tx) => tx.append(pending));
    for (const row of rows) evolve(this.model, row);
    if (rows.length > 0) for (const listener of this.listeners) listener(rows);
    return decision.ok
      ? { ok: true, events: rows, output: decision.output }
      : { ok: false, rejection: decision.rejection, events: rows };
  }
}
