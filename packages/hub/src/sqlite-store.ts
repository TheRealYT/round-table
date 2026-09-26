import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { EventRow, PendingEvent, StreamId } from '@round-table/protocol';
import type { EventStore, Projector, SqlTx, StoreTx } from './store.ts';

/**
 * EventStore on node:sqlite (S0: WAL + synchronous=FULL, ~3,700 commands/s). One file per hub.
 * Projections are updated inside the same transaction as the append.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;
  private readonly sql: SqlTx;
  private readonly projectors: Projector[];
  private readonly nextSseq = new Map<string, number>();

  constructor(path: string, projectors: Projector[] = []) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        gpos INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        sseq INTEGER NOT NULL,
        project_id TEXT,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        via TEXT NOT NULL,
        ts INTEGER NOT NULL,
        refs TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT,
        durability TEXT NOT NULL,
        UNIQUE (stream, sseq)
      );
      CREATE INDEX IF NOT EXISTS events_project ON events (project_id, gpos);
      CREATE INDEX IF NOT EXISTS events_type ON events (type, gpos);
    `);
    this.sql = {
      run: (sql, params = []) => void this.db.prepare(sql).run(...(params as SQLInputValue[])),
      all: <T>(sql: string, params: readonly unknown[] = []) => this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
      get: <T>(sql: string, params: readonly unknown[] = []) => this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined,
    };
    this.projectors = projectors;
    for (const p of projectors) p.migrate(this.sql);
  }

  /** Read access for queries (read models live in the same database). */
  get reader(): SqlTx {
    return this.sql;
  }

  transaction<T>(fn: (tx: StoreTx) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const reserved = new Map<string, number>();
    try {
      const tx: StoreTx = {
        sql: this.sql,
        append: (events) => events.map((e) => this.appendOne(e, reserved)),
      };
      const result = fn(tx);
      this.db.exec('COMMIT');
      for (const [stream, next] of reserved) this.nextSseq.set(stream, next);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private appendOne(event: PendingEvent, reserved: Map<string, number>): EventRow {
    const sseq = reserved.get(event.stream) ?? this.nextSseq.get(event.stream) ?? this.lastSseq(event.stream) + 1;
    reserved.set(event.stream, sseq + 1);
    const result = this.db
      .prepare(
        `INSERT INTO events (stream, sseq, project_id, type, actor, role, via, ts, refs, payload, reason, durability)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.stream,
        sseq,
        event.projectId,
        event.type,
        event.actor,
        event.role,
        event.via,
        event.ts,
        JSON.stringify(event.refs),
        JSON.stringify(event.payload ?? null),
        event.reason,
        event.durability,
      );
    const row: EventRow = { ...event, gpos: Number(result.lastInsertRowid), sseq };
    for (const p of this.projectors) if (p.handles.includes(row.type)) p.apply(this.sql, row);
    return row;
  }

  private lastSseq(stream: string): number {
    const row = this.db.prepare('SELECT MAX(sseq) AS last FROM events WHERE stream = ?').get(stream) as { last: number | null };
    return row.last ?? 0;
  }

  read(stream: StreamId, afterSseq: number, limit = 10_000): EventRow[] {
    return this.sql
      .all<RawRow>('SELECT * FROM events WHERE stream = ? AND sseq > ? ORDER BY sseq LIMIT ?', [stream, afterSseq, limit])
      .map(toRow);
  }

  /** The newest `limit` events of one stream, oldest first. */
  tail(stream: StreamId, limit: number): EventRow[] {
    return this.sql
      .all<RawRow>('SELECT * FROM (SELECT * FROM events WHERE stream = ? ORDER BY sseq DESC LIMIT ?) ORDER BY sseq', [stream, limit])
      .map(toRow);
  }

  /** Every event in global order, for loading the write model at startup. */
  *all(batch = 5_000): Generator<EventRow> {
    let after = 0;
    for (;;) {
      const rows = this.sql.all<RawRow>('SELECT * FROM events WHERE gpos > ? ORDER BY gpos LIMIT ?', [after, batch]);
      if (rows.length === 0) return;
      for (const r of rows) yield toRow(r);
      after = rows[rows.length - 1]!.gpos;
    }
  }

  latestSnapshot(): EventRow | undefined {
    // Snapshots arrive with retention in S6 (ADR-0006).
    return undefined;
  }

  prune(): { deleted: number } {
    throw new Error('retention and pruning arrive in slice S6 (ADR-0006)');
  }

  /** Drops and rebuilds every projection from the log (invariant 2). */
  rebuildProjections(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of this.projectors) p.reset(this.sql);
      for (const row of this.all()) for (const p of this.projectors) if (p.handles.includes(row.type)) p.apply(this.sql, row);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

interface RawRow {
  gpos: number;
  stream: string;
  sseq: number;
  project_id: string | null;
  type: string;
  actor: string;
  role: string;
  via: string;
  ts: number;
  refs: string;
  payload: string;
  reason: string | null;
  durability: string;
}

function toRow(r: RawRow): EventRow {
  return {
    gpos: r.gpos,
    stream: r.stream as StreamId,
    sseq: r.sseq,
    projectId: r.project_id,
    type: r.type,
    actor: r.actor,
    role: r.role as EventRow['role'],
    via: r.via as EventRow['via'],
    ts: r.ts,
    refs: JSON.parse(r.refs) as EventRow['refs'],
    payload: JSON.parse(r.payload) as unknown,
    reason: r.reason,
    durability: r.durability as EventRow['durability'],
  };
}
