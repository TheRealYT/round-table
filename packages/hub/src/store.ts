import type { EventRow, PendingEvent, StreamId } from '@round-table/protocol';

/**
 * The event store port (ADR-0005, ADR-0006). The MVP adapter is SQLite (node:sqlite, WAL mode)
 * with one file per hub: an append-only `events` table plus projection tables updated in the
 * same transaction.
 */
export interface EventStore {
  /** Runs `fn` in one write transaction. Everything a command produces commits or rolls back together. */
  transaction<T>(fn: (tx: StoreTx) => T): T;
  /** Events of one stream with sseq > `afterSseq`, in order. */
  read(stream: StreamId, afterSseq: number, limit?: number): EventRow[];
  /** The newest snapshot of `stream` at or before `atSseq` (default: latest). */
  latestSnapshot(stream: StreamId, atSseq?: number): EventRow | undefined;
  /** Deletes ephemeral events older than `beforeTs` on streams that have a snapshot covering them. */
  prune(beforeTs: number): { deleted: number };
  close(): void;
}

export interface StoreTx {
  /** Appends in order; assigns gpos and per-stream sseq. */
  append(events: readonly PendingEvent[]): EventRow[];
  /** Raw access for projectors, scoped to this transaction. */
  sql: SqlTx;
}

/** The narrow SQL surface projectors use, so they can be tested against an in-memory database. */
export interface SqlTx {
  run(sql: string, params?: readonly unknown[]): void;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
}

/**
 * A read model. `apply` runs inside the append transaction for every new row it cares about.
 * `reset` + re-applying the whole log must give identical tables (invariant 2).
 */
export interface Projector {
  readonly name: string;
  readonly handles: readonly string[];
  migrate(sql: SqlTx): void;
  reset(sql: SqlTx): void;
  apply(sql: SqlTx, row: EventRow): void;
}
