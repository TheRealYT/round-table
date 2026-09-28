import type { ReactNode } from 'react';
import { Activity, Bot, Clock, Coins, Cpu, Gauge, Lightbulb, MessagesSquare, Timer } from 'lucide-react';
import { useQuery } from '../hub.tsx';
import { duration, tokens, usd } from '../format.ts';
import { Avatar } from '../ui.tsx';

/** Mirrors `Insights` in core (the app only depends on protocol). */
export interface InsightsData {
  startedAt: number | null;
  endedAt: number | null;
  wallMs: number;
  tasks: Array<{
    taskId: string;
    title: string;
    status: string;
    owner: string | null;
    leadMs: number | null;
    phases: Record<Phase, number | null>;
    reworks: number;
    conflicts: number;
    failedHubRuns: number;
  }>;
  agents: Array<{
    agentId: string;
    name: string;
    role: string;
    turns: number;
    workingMs: number;
    costUsd: number;
    tokens: number;
    shortTurns: number;
    byTrigger: Partial<Record<string, { turns: number; ms: number; costUsd: number }>>;
  }>;
  totals: { turns: number; workingMs: number; costUsd: number; tokens: number; approvalWaitMs: number; hubRuns: number; hubRunMs: number; conflicts: number; messages: number; broadcasts: number; deliveries: number; peakParallel: number };
  findings: string[];
}

type Phase = 'approval' | 'toClaim' | 'coding' | 'verify' | 'hubRun';
const PHASES: Array<{ id: Phase; label: string; color: string }> = [
  { id: 'approval', label: 'Waiting for approval', color: 'var(--text-faint)' },
  { id: 'toClaim', label: 'Waiting to be claimed', color: 'var(--idle)' },
  { id: 'coding', label: 'Coding', color: 'var(--accent)' },
  { id: 'verify', label: 'Review and test', color: 'oklch(0.72 0.14 300)' },
  { id: 'hubRun', label: 'Hub checks and merge', color: 'var(--working)' },
];
const TRIGGERS: Array<{ id: string; label: string; color: string }> = [
  { id: 'kickoff', label: 'start', color: 'var(--text-faint)' },
  { id: 'nudge', label: 'board step', color: 'var(--accent)' },
  { id: 'agent', label: 'agent message', color: 'var(--idle)' },
  { id: 'human', label: 'you', color: 'var(--human)' },
  { id: 'critical', label: 'critical', color: 'var(--crashed)' },
  { id: 'hub', label: 'hub alert', color: 'oklch(0.72 0.14 300)' },
  { id: 'broadcast', label: 'broadcast', color: 'oklch(0.75 0.13 330)' },
  { id: 'notice', label: 'notice', color: 'var(--starting)' },
];

export function InsightsTab({ projectId }: { projectId: string }) {
  const { data: x, error } = useQuery<InsightsData>('project.insights', { projectId }, { pollMs: 10_000 });
  if (error) return <p className="error">{error}</p>;
  if (!x) return null;
  if (x.wallMs === 0 && x.totals.turns === 0) {
    return (
      <div className="empty">
        <Gauge className="empty-icon" />
        <strong>Nothing to measure yet</strong>
        <p>Once agents start working, this shows where the time goes: each task's phases, how busy each agent is, and what woke them.</p>
      </div>
    );
  }
  const t = x.totals;
  const longest = Math.max(1, ...x.tasks.map((task) => PHASES.reduce((n, p) => n + (task.phases[p.id] ?? 0), 0)));
  return (
    <div className="insights">
      <div className="statline">
        <Stat icon={<Clock />} v={duration(x.wallMs)} k="wall time" />
        <Stat icon={<Cpu />} v={duration(t.workingMs)} k="agent work" />
        <Stat icon={<Activity />} v={String(t.turns)} k="turns" />
        <Stat icon={<Coins />} v={usd(t.costUsd)} k="spent" />
        <Stat icon={<Bot />} v={tokens(t.tokens)} k="tokens" />
        <Stat icon={<MessagesSquare />} v={`${t.messages}`} k={`messages, ${t.broadcasts} to everyone`} />
        <Stat icon={<Timer />} v={`${t.hubRuns}`} k={`hub checks, ${duration(t.hubRunMs)}`} />
      </div>

      {x.findings.length > 0 && (
        <section className="panel">
          <div className="panel-head"><Lightbulb /><h2>Where the time went</h2></div>
          <ol className="findings">{x.findings.map((f, i) => <li key={i}>{f}</li>)}</ol>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><Timer /><h2>Tasks</h2><div className="actions legend">{PHASES.map((p) => <span key={p.id}><i style={{ background: p.color }} />{p.label}</span>)}</div></div>
        <ul className="waterfall">
          {x.tasks.map((task) => (
            <li key={task.taskId}>
              <div className="wf-title"><span className="truncate" title={task.title}>{task.title}</span><span className="faint xs">{task.status.replace('_', ' ')}{task.leadMs !== null ? ` · ${duration(task.leadMs)}` : ''}{task.reworks ? ` · ${task.reworks} rework` : ''}{task.conflicts ? ` · ${task.conflicts} conflict` : ''}</span></div>
              <div className="wf-bar" role="img" aria-label={PHASES.filter((p) => task.phases[p.id] !== null).map((p) => `${p.label} ${duration(task.phases[p.id]!)}`).join(', ')}>
                {PHASES.map((p) => {
                  const ms = task.phases[p.id];
                  return ms ? <i key={p.id} style={{ width: `${(100 * ms) / longest}%`, background: p.color }} title={`${p.label}: ${duration(ms)}`} /> : null;
                })}
              </div>
            </li>
          ))}
          {x.tasks.length === 0 && <li className="faint small">No tasks yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head"><Bot /><h2>Agents</h2><div className="actions legend">{TRIGGERS.map((g) => <span key={g.id}><i style={{ background: g.color }} />{g.label}</span>)}</div></div>
        <ul className="agent-usage">
          {x.agents.map((a) => {
            const busy = x.wallMs > 0 ? Math.min(1, a.workingMs / x.wallMs) : 0;
            const counted = TRIGGERS.reduce((n, g) => n + (a.byTrigger[g.id]?.turns ?? 0), 0);
            return (
              <li key={a.agentId}>
                <div className="au-who"><Avatar name={a.name} size="xs" leader={a.role === 'leader'} /><strong>{a.name}</strong><span className="faint xs">{a.role}</span></div>
                <div className="au-busy">
                  <div className="meter" role="img" aria-label={`busy ${Math.round(busy * 100)}%`}><i style={{ width: `${busy * 100}%` }} /></div>
                  <span className="xs faint">busy {Math.round(busy * 100)}%</span>
                </div>
                <div className="au-triggers">
                  <div className="wf-bar thin" role="img" aria-label={TRIGGERS.filter((g) => a.byTrigger[g.id]).map((g) => `${a.byTrigger[g.id]!.turns} ${g.label}`).join(', ')}>
                    {TRIGGERS.map((g) => {
                      const n = a.byTrigger[g.id]?.turns ?? 0;
                      return n ? <i key={g.id} style={{ width: `${(100 * n) / Math.max(1, counted)}%`, background: g.color }} title={`${n} turns started by ${g.label}`} /> : null;
                    })}
                  </div>
                  <span className="xs faint">{a.turns} turns{a.shortTurns ? `, ${a.shortTurns} under 5 s` : ''}</span>
                </div>
                <div className="au-cost num small">{usd(a.costUsd)}<span className="faint xs"> · {tokens(a.tokens)}</span></div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Stat({ icon, v, k }: { icon: ReactNode; v: string; k: string }) {
  return <div className="stat"><span className="v">{v}</span><span className="k">{icon}{k}</span></div>;
}
