import { computeInsights, type InsightStep, type Insights } from '@round-table/core';
import type { ProjectId } from '@round-table/protocol';
import type { SqlTx } from './store.ts';

/**
 * A project's insights from the hub database: its event stream, leader changes from the system
 * stream, and the session steps of its hub-run agents. Works on a live hub and on a copy of the
 * database (`rt report`).
 */
export function projectInsights(sql: SqlTx, projectId: ProjectId | string): Insights {
  type Raw = { type: string; ts: number; actor: string; payload: string };
  const rows = sql.all<Raw>('SELECT type, ts, actor, payload FROM events WHERE stream = ? ORDER BY gpos', [`project:${projectId}`]);
  const system = sql.all<Raw>("SELECT type, ts, actor, payload FROM events WHERE stream = 'system' AND type = 'leader.assigned' ORDER BY gpos");
  const events = [...rows, ...system]
    .map((r) => ({ type: r.type, ts: r.ts, actor: r.actor, payload: JSON.parse(r.payload) as Record<string, unknown> }))
    .filter((r) => r.type !== 'leader.assigned' || r.payload.projectId === projectId);
  const agentIds = new Set(events.filter((e) => e.type === 'roster.joined').map((e) => e.payload.agentId as string));
  const steps: InsightStep[] = [];
  const hasSteps = sql.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'agent_steps'")?.n;
  if (hasSteps && agentIds.size > 0) {
    const ids = [...agentIds];
    const found = sql.all<{ agent_id: string; at: number; kind: string; text: string; data: string | null }>(
      `SELECT agent_id, at, kind, text, data FROM agent_steps WHERE kind IN ('to_agent', 'turn') AND agent_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids,
    );
    for (const s of found) steps.push({ agentId: s.agent_id, at: s.at, kind: s.kind, text: s.text, data: s.data ? (JSON.parse(s.data) as Record<string, unknown>) : null });
  }
  return computeInsights(events, steps);
}
