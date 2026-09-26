import { PRIORITIES, priorityRank, type EventRow, type InboxCounts, type MessageEnvelope, type MessagePayload } from '@round-table/protocol';
import type { Projector, SqlTx } from '../store.ts';

/**
 * Delivery rows (architecture §4.4): one row per recipient of each message, written in the
 * append transaction. Recipients are resolved in core, so rebuilding gives the same rows.
 * `acked_at` is operational state (what rt-agent has handed to the model), not part of the log.
 */
export const deliveriesProjector: Projector = {
  name: 'deliveries',
  handles: ['message.sent', 'human.posted'],
  migrate(sql) {
    sql.run(`CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      gpos INTEGER NOT NULL,
      priority_rank INTEGER NOT NULL,
      priority TEXT NOT NULL,
      envelope TEXT NOT NULL,
      acked_at INTEGER,
      UNIQUE (agent_id, gpos)
    )`);
    sql.run('CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (agent_id, acked_at, priority_rank, gpos)');
  },
  reset(sql) {
    sql.run('DELETE FROM deliveries');
  },
  apply(sql, row) {
    const p = row.payload as MessagePayload;
    const envelope: MessageEnvelope = {
      id: p.messageId,
      seq: row.sseq,
      from: p.from,
      role: p.role,
      to: p.to,
      channel: p.channel,
      type: p.type,
      priority: p.priority,
      ref: p.ref,
      body: p.body,
      ts: row.ts,
    };
    const text = JSON.stringify(envelope);
    for (const agentId of p.recipients) {
      sql.run('INSERT INTO deliveries (project_id, agent_id, gpos, priority_rank, priority, envelope) VALUES (?, ?, ?, ?, ?, ?)', [
        row.projectId,
        agentId,
        row.gpos,
        priorityRank(p.priority),
        p.priority,
        text,
      ]);
    }
  },
};

/** Agents whose inbox a committed row changed, with the row's priority. */
export function deliveryTargets(row: EventRow): { agentId: string; priority: MessageEnvelope['priority'] }[] {
  if (!deliveriesProjector.handles.includes(row.type)) return [];
  const p = row.payload as MessagePayload;
  return p.recipients.map((agentId) => ({ agentId, priority: p.priority }));
}

export interface Delivery {
  deliveryId: number;
  message: MessageEnvelope;
}

export function pendingDeliveries(sql: SqlTx, agentId: string, maxChars: number): { items: Delivery[]; more: number } {
  const rows = sql.all<{ id: number; envelope: string }>(
    'SELECT id, envelope FROM deliveries WHERE agent_id = ? AND acked_at IS NULL ORDER BY priority_rank, gpos LIMIT 200',
    [agentId],
  );
  const items: Delivery[] = [];
  let used = 0;
  for (const r of rows) {
    if (items.length > 0 && used + r.envelope.length > maxChars) break;
    items.push({ deliveryId: r.id, message: JSON.parse(r.envelope) as MessageEnvelope });
    used += r.envelope.length;
  }
  const total = sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked_at IS NULL', [agentId])?.n ?? 0;
  return { items, more: total - items.length };
}

export function ackDeliveries(sql: SqlTx, agentId: string, ids: readonly number[], now: number): void {
  for (const id of ids) sql.run('UPDATE deliveries SET acked_at = ? WHERE id = ? AND agent_id = ? AND acked_at IS NULL', [now, id, agentId]);
}

export function inboxCounts(sql: SqlTx, agentId: string): InboxCounts {
  const counts = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as InboxCounts;
  for (const r of sql.all<{ priority: keyof InboxCounts; n: number }>(
    'SELECT priority, COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked_at IS NULL GROUP BY priority',
    [agentId],
  )) {
    counts[r.priority] = r.n;
  }
  return counts;
}
