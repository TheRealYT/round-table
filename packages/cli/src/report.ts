import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { formatMs, type Insights } from '@round-table/core';
import { projectInsights, type SqlTx } from '@round-table/hub';
import { rtHome } from '@round-table/agent';

/**
 * `rt report`: where a project's time went, read from the hub database (also while the hub runs,
 * or from a copy someone sent). Plain text for people, `--json` for tools.
 */
export function report(args: string[]): void {
  const { values } = parseArgs({ args, options: { project: { type: 'string' }, data: { type: 'string' }, db: { type: 'string' }, json: { type: 'boolean' } } });
  const path = resolve(values.db ?? join(values.data ?? join(rtHome(), 'hub'), 'hub.db'));
  if (!existsSync(path)) throw new Error(`no hub database at ${path} (use --data <dir> or --db <file>)`);
  const db = new DatabaseSync(path, { readOnly: true });
  const sql: SqlTx = {
    run: () => {
      throw new Error('read-only');
    },
    all: <T>(q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as T[],
    get: <T>(q: string, p: readonly unknown[] = []) => db.prepare(q).get(...(p as never[])) as T | undefined,
  };
  try {
    const projects = sql
      .all<{ payload: string }>("SELECT payload FROM events WHERE type = 'project.created' ORDER BY gpos")
      .map((r) => JSON.parse(r.payload) as { projectId: string; name: string });
    if (projects.length === 0) throw new Error('this hub has no projects');
    const wanted = values.project?.toLowerCase();
    const project = wanted ? projects.find((p) => p.projectId.toLowerCase() === wanted || p.name.toLowerCase() === wanted) : projects.at(-1);
    if (!project) throw new Error(`no project "${values.project}"; projects: ${projects.map((p) => p.name).join(', ')}`);
    const insights = projectInsights(sql, project.projectId);
    console.log(values.json ? JSON.stringify({ project, ...insights }, null, 2) : renderReport(project.name, insights));
  } finally {
    db.close();
  }
}

export function renderReport(name: string, x: Insights): string {
  const t = x.totals;
  const lines = [
    `Round Table report: ${name}`,
    `  ${formatMs(x.wallMs)} wall time · ${t.turns} turns · ${formatMs(t.workingMs)} of agent work · $${t.costUsd.toFixed(2)} · ${t.tokens.toLocaleString('en')} tokens`,
    '',
    'Findings (biggest first):',
    ...x.findings.map((f) => `  - ${f}`),
    '',
    'Tasks:',
    ...x.tasks.map((task) => {
      const p = task.phases;
      const part = (label: string, ms: number | null) => (ms === null ? '' : ` ${label} ${formatMs(ms)}`);
      return `  ${task.status.padEnd(11)} ${task.title.slice(0, 50).padEnd(50)} ${task.leadMs === null ? '' : formatMs(task.leadMs).padStart(12)} |${part('approval', p.approval)}${part('to-claim', p.toClaim)}${part('coding', p.coding)}${part('verify', p.verify)}${part('hub', p.hubRun)}${task.reworks ? ` reworks ${task.reworks}` : ''}${task.conflicts ? ` conflicts ${task.conflicts}` : ''}`;
    }),
    '',
    'Agents:',
    ...x.agents.map((a) => {
      const triggers = Object.entries(a.byTrigger).map(([k, v]) => `${k} ${v.turns}`).join(', ');
      const busy = x.wallMs > 0 ? Math.round((a.workingMs / x.wallMs) * 100) : 0;
      return `  ${`${a.name} (${a.role})`.padEnd(20)} ${String(a.turns).padStart(4)} turns  busy ${String(busy).padStart(3)}%  $${a.costUsd.toFixed(2).padStart(6)}  short ${a.shortTurns}${triggers ? `  started by: ${triggers}` : ''}`;
    }),
    '',
    `Hub checks: ${t.hubRuns} runs, ${formatMs(t.hubRunMs)}. Conflicts: ${t.conflicts}. Messages: ${t.messages} (${t.broadcasts} to everyone), ${t.deliveries} deliveries. Most tasks in progress at once: ${t.peakParallel}.`,
  ];
  return lines.join('\n');
}
