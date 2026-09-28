import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, Gauge, Bot, CircleAlert, Coins, Cpu, FlaskConical, FolderGit2, GitMerge, GitPullRequest, KeyRound, LayoutGrid,
  ListChecks, MessageSquare, Pause, Play, Radio, RotateCcw, Send, Settings2, Sparkles, Square, Terminal, UserPlus, Users, Wrench,
} from 'lucide-react';
import { go } from '../App.tsx';
import { useCommand, useQuery } from '../hub.tsx';
import { clock, shortId, tokens, toolName, usd } from '../format.ts';
import type { LogEvent, ProjectSummary, RosterRecord } from '../types.ts';
import { Avatar, RunState, SEAT_LABEL, seatOf, Sparkline, STOPPED_AFTER_MS, TASK_COLOR, TASK_COLUMNS, TaskProgress, useNow, useToast, type Seat } from '../ui.tsx';
import { ChangesTable, Kanban, SetupPanel, setupComplete, type BoardOverview, type Change } from './Board.tsx';
import { StateDot } from './Pairing.tsx';
import { StartAgentsSheet } from './StartAgents.tsx';
import { AgentLog } from './AgentLog.tsx';
import { InsightsTab } from './Insights.tsx';

const FEED_TYPES = [
  'human.posted', 'message.sent', 'roster.joined', 'roster.connected', 'roster.disconnected',
  'roster.stale', 'roster.gone', 'roster.role_changed', 'activity.reported',
  'entry.versioned', 'task.status_changed', 'change_request.merged', 'agent.turn_finished',
];

type Tab = 'table' | 'board' | 'changes' | 'activity' | 'insights' | 'setup';

export function ProjectView({ project, tab: routeTab }: { project: ProjectSummary; tab: string }) {
  const projectId = project.projectId;
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId }, { pollMs: 2_000 });
  const { data: view } = useQuery<BoardOverview>('board_view', { view: 'overview', projectId });
  const { data: changes } = useQuery<{ records: Change[] }>('board_read', { section: 'artifacts', projectId, limit: 50 });
  const { data: log } = useQuery<{ events: LogEvent[] }>('logs.query', { projectId, filter: { last: true, types: FEED_TYPES }, limit: 400 });
  const [starting, setStarting] = useState(false);
  // The conversation sits beside the tabs on wide screens; on narrower ones it opens on demand.
  const [chatOpen, setChatOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1600);
  const [approve, approving] = useCommand('plan.approve');
  const toast = useToast();
  const agents = useMemo(() => (roster?.records ?? []).filter((a) => a.state !== 'removed' && a.state !== 'left'), [roster]);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));
  const name = (id: string | null) => (id ? names.get(id) ?? shortId(id) : '—');
  const events = log?.events ?? [];
  const cost = agents.reduce((n, a) => n + (a.driven?.costUsd ?? 0), 0);
  const messages = events.filter((e) => e.type === 'message.sent' || e.type === 'human.posted').length;
  const complete = view ? setupComplete(view) : true;
  const tab: Tab = (['table', 'board', 'changes', 'activity', 'insights', 'setup'] as const).includes(routeTab as Tab) ? (routeTab as Tab) : 'table';
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    // A new project opens on Setup until it has a goal, a repository and a test command.
    if (view && !defaulted) {
      setDefaulted(true);
      if (!complete && routeTab === 'table' && !location.hash.endsWith('/table')) go({ view: 'project', projectId, tab: 'setup' });
    }
  }, [view, defaulted, complete, routeTab, projectId]);
  const proposed = view?.taskCounts.proposed ?? 0;
  const setTab = (t: Tab) => go({ view: 'project', projectId, tab: t });
  const tabs: Array<{ id: Tab; label: string; icon: ReactNode; count?: number; dot?: boolean }> = [
    { id: 'table', label: 'Table', icon: <Users />, count: agents.length },
    { id: 'board', label: 'Board', icon: <LayoutGrid />, count: view?.tasks.length },
    { id: 'changes', label: 'Changes', icon: <GitPullRequest />, count: changes?.records.length },
    { id: 'activity', label: 'Activity', icon: <Activity /> },
    { id: 'insights', label: 'Insights', icon: <Gauge /> },
    { id: 'setup', label: 'Setup', icon: <Settings2 />, dot: !complete },
  ];

  return (
    <div className="page">
      <header className="project-hero">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow row faint small" style={{ gap: 6, marginBottom: 'var(--s-2)' }}><FolderGit2 size={14} /> Project</div>
          <h1>{project.name}</h1>
          {view?.goal ? <p className="goal">{String(view.goal.data.objective ?? '')}</p> : <p className="goal muted">No goal yet — set one under Setup and every agent is told at once.</p>}
          <div className="facts">
            <span className="badge"><Users /> {agents.length} agent{agents.length === 1 ? '' : 's'}</span>
            {view?.project.repo && <span className="badge" title={view.project.repo}><FolderGit2 /> <span className="mono">{view.project.repo.split('/').slice(-2).join('/')}</span></span>}
            {view?.rules?.data.testCommand ? <span className="badge"><FlaskConical /> <span className="mono">{String(view.rules.data.testCommand)}</span></span> : null}
            {cost > 0 && <span className="badge"><Coins /> <span className="num">{usd(cost)}</span></span>}
            {(view?.openTickets ?? 0) > 0 && <span className="badge accent"><ListChecks /> {view!.openTickets} proposal{view!.openTickets === 1 ? '' : 's'} waiting for the leader</span>}
          </div>
        </div>
        <div className="row">
          {proposed > 0 && (
            <button className="primary" disabled={approving} onClick={async () => { if (await approve({ projectId })) toast('Plan approved: tasks are ready to claim'); }}>
              <ListChecks /> Approve plan ({proposed} proposed)
            </button>
          )}
          <button className={proposed > 0 ? '' : 'primary'} onClick={() => setStarting(true)}><UserPlus /> Start agents</button>
        </div>
      </header>

      {view && view.tasks.length > 0 && (
        <div className="progress-block">
          <TaskProgress counts={view.taskCounts} />
          <div className="legend">
            {TASK_COLUMNS.filter((c) => view.taskCounts[c]).map((c) => <span key={c}><i style={{ background: TASK_COLOR[c] }} />{view.taskCounts[c]} {c.replace('_', ' ')}</span>)}
          </div>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Project">
        {tabs.map((t) => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.icon}{t.label}
            {t.count ? <span className="count-badge">{t.count}</span> : null}
            {t.dot && <span className="pill-dot" style={{ background: 'var(--accent)' }} aria-label="needs setup" />}
          </button>
        ))}
        <span className="spacer" />
        <button className={`tab ${chatOpen ? '' : 'accent-tab'}`} aria-pressed={chatOpen} onClick={() => setChatOpen(!chatOpen)} title={chatOpen ? 'Hide the conversation' : 'Show the conversation'}>
          <MessageSquare />Conversation{!chatOpen && messages > 0 ? <span className="count-badge hot">{messages}</span> : null}
        </button>
      </div>

      <div className={`project-layout ${chatOpen ? '' : 'solo'}`}>
        <div style={{ minWidth: 0 }} role="tabpanel">
          {tab === 'table' && <TableTab projectId={projectId} agents={agents} events={events} cost={cost} onStart={() => setStarting(true)} />}
          {tab === 'board' && view && <Kanban view={view} name={name} />}
          {tab === 'changes' && <ChangesTable changes={changes?.records ?? []} name={name} />}
          {tab === 'activity' && <ActivityTimeline events={events} name={name} />}
          {tab === 'insights' && <InsightsTab projectId={projectId} />}
          {tab === 'setup' && view && <SetupPanel projectId={projectId} view={view} />}
        </div>
        {chatOpen && <aside className="project-side" aria-label="Feed">
          <div className="panel convo">
            <div className="panel-head"><MessageSquare /><h2>Conversation</h2><span className="faint xs" style={{ marginLeft: 'auto' }}>your messages outrank the board</span></div>
            <Feed events={events} names={names} />
            <Composer projectId={projectId} agents={agents} />
          </div>
        </aside>}
      </div>
      <StartAgentsSheet open={starting} onClose={() => setStarting(false)} projectId={projectId} />
    </div>
  );
}

// ── the table ──────────────────────────────────────────────────────────────────────────

function TableTab({ projectId, agents, events, cost, onStart }: { projectId: string; agents: RosterRecord[]; events: LogEvent[]; cost: number; onStart: () => void }) {
  const [selected, setSelected] = useState<string>();
  const current = agents.find((a) => a.agentId === selected) ?? agents.find((a) => a.role === 'leader') ?? agents[0];
  if (agents.length === 0) {
    return (
      <div className="empty">
        <Users className="empty-icon" />
        <strong>No one at the table yet</strong>
        <p>Start agents from a provider: the hub runs them, gives each its own worktree, and wakes them when there is work. Or pair one from your own chat on the Pairing page.</p>
        <div className="row"><button className="primary" onClick={onStart}><UserPlus /> Start agents</button><button className="ghost" onClick={() => go({ view: 'pairing' })}>Pair from a chat</button></div>
      </div>
    );
  }
  return (
    <>
      <div className="stage">
        <div className="table-wrap-outer">
          <RoundTable agents={agents} selected={current?.agentId} onSelect={setSelected} events={events} cost={cost} />
          <div className="legend" style={{ justifyContent: 'center', marginTop: 'var(--s-2)' }}>
            {(['working', 'idle', 'stopped', 'crashed'] as const).map((s) => <span key={s}><i style={{ background: `var(--${s})`, borderRadius: '50%' }} />{s === 'crashed' ? 'needs you' : s}</span>)}
          </div>
        </div>
        {current && <Inspector agent={current} projectId={projectId} events={events} />}
      </div>
      {current?.driven && <div style={{ marginTop: 'var(--s-5)' }}><AgentLog key={current.agentId} projectId={projectId} agent={current} /></div>}
      <section className="section" style={{ marginTop: 'var(--s-6)' }} aria-label="Agents">
        <div className="section-head"><h2>Roster</h2></div>
        <div className="providers" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', display: 'grid', gap: 'var(--s-3)' }}>
          {agents.map((a) => <AgentCard key={a.agentId} agent={a} projectId={projectId} current={a.agentId === current?.agentId} onSelect={() => setSelected(a.agentId)} />)}
        </div>
      </section>
    </>
  );
}

const MESSAGE_WINDOW_MS = 120_000;

/**
 * The signature view: seats around a table, the leader at the head, each ringed by its status.
 * Recent messages are drawn as arcs between seats (yours come from the table itself), fading out
 * over two minutes; a fresh one sends a pulse along its arc.
 */
function RoundTable({ agents, selected, onSelect, events, cost }: { agents: RosterRecord[]; selected: string | undefined; onSelect: (id: string) => void; events: LogEvent[]; cost: number }) {
  const now = useNow(1_000);
  const ordered = [...agents].sort((a, b) => (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : 0));
  const R = 158;
  const pos = new Map(ordered.map((a, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ordered.length;
    return [a.agentId, { x: 200 + R * Math.cos(angle), y: 200 + R * Math.sin(angle), angle }] as const;
  }));
  const seats = ordered.map((a) => seatOf(a, now));
  const working = seats.filter((s) => s === 'working').length;
  const chords = events
    .filter((e) => (e.type === 'message.sent' || e.type === 'human.posted') && now - e.ts < MESSAGE_WINDOW_MS)
    .flatMap((e) => {
      const recipients = (e.payload.recipients as string[] | undefined) ?? [];
      const from = e.type === 'human.posted' ? null : pos.get(String(e.payload.from));
      if (e.type === 'message.sent' && !from) return [];
      return recipients.filter((r) => pos.has(r) && r !== e.payload.from).map((r) => ({ key: `${e.gpos}-${r}`, from, to: pos.get(r)!, age: now - e.ts, human: e.type === 'human.posted' }));
    });
  return (
    <svg className="roundtable" viewBox="-56 -44 512 494" role="group" aria-label="Seats">
      <defs>
        <radialGradient id="wood" cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor="var(--wood-1)" />
          <stop offset="100%" stopColor="var(--wood-2)" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="104" className="wood" />
      <circle cx="200" cy="200" r="92" className="inlay" />
      {chords.map((c) => {
        const from = c.from ?? { x: 200, y: 200 };
        const d = `M${from.x},${from.y} Q${200 + (from.x + c.to.x - 400) * 0.12},${200 + (from.y + c.to.y - 400) * 0.12} ${c.to.x},${c.to.y}`;
        const fresh = c.age < 6_000;
        return (
          <g key={c.key}>
            <path d={d} className={`chord ${c.human ? 'human' : ''}`} strokeWidth={fresh ? 2.2 : 1.4} strokeOpacity={Math.max(0.12, 0.85 * (1 - c.age / MESSAGE_WINDOW_MS))} strokeDasharray={c.human ? '4 4' : undefined} />
            {fresh && (
              <circle r="3.5" className="pulse">
                <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
              </circle>
            )}
          </g>
        );
      })}
      <circle cx="200" cy="205" r="52" className="center-disc" />
      <text x="200" y="196" textAnchor="middle" className="center-num">{working}/{agents.length}</text>
      <text x="200" y="218" textAnchor="middle" className="center-label">WORKING</text>
      {cost > 0 && <text x="200" y="238" textAnchor="middle" className="center-sub">{usd(cost)}</text>}
      {ordered.map((a, i) => {
        const p = pos.get(a.agentId)!;
        const seat = seats[i]!;
        const lx = 200 + (R + 54) * Math.cos(p.angle);
        const ly = 200 + (R + 54) * Math.sin(p.angle) + 5;
        const tool = a.driven?.live.status === 'working' && a.driven.live.tool ? toolName(a.driven.live.tool) : null;
        return (
          <g
            key={a.agentId}
            className={`seat ${seat}`}
            role="button"
            tabIndex={0}
            aria-pressed={a.agentId === selected}
            aria-label={`${a.name}, ${a.role}, ${SEAT_LABEL[seat]}`}
            onClick={() => onSelect(a.agentId)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(a.agentId))}
          >
            <circle cx={p.x} cy={p.y} r="37" className="halo" />
            <circle cx={p.x} cy={p.y} r="30" className="ring" />
            {seat === 'working' && <circle cx={p.x} cy={p.y} r="30" className="spin" />}
            {a.role === 'leader' && <path className="crown" transform={`translate(${p.x - 9},${p.y - 47})`} d="M1 11h16L15 3l-4 4-2-6-2 6-4-4z" />}
            <text x={p.x} y={p.y + 5} textAnchor="middle" className="initials">{a.name.slice(0, 2).toUpperCase()}</text>
            <text x={lx} y={ly} textAnchor="middle" className="name">{a.name}</text>
            {tool && <text x={lx} y={ly + 13} textAnchor="middle" className="tool">{tool.length > 16 ? `${tool.slice(0, 15)}…` : tool}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Inspector({ agent, projectId, events }: { agent: RosterRecord; projectId: string; events: LogEvent[] }) {
  const d = agent.driven;
  const now = useNow();
  const [setRun, running] = useCommand('agent.run');
  const [interrupt, interrupting] = useCommand('agent.interrupt');
  const [assign, assigning] = useCommand('leader.assign');
  const toast = useToast();
  const turns = events.filter((e) => e.type === 'agent.turn_finished' && e.payload.agentId === agent.agentId);
  const perTurn = turns.slice(-24).map((e) => Number(e.payload.inputTokens ?? 0) + Number(e.payload.outputTokens ?? 0));
  const seat = seatOf(agent, now);
  return (
    <div className="inspector" aria-label={`${agent.name} details`}>
      <div className="inspector-head">
        <Avatar name={agent.name} seat={seat} leader={agent.role === 'leader'} size="lg" />
        <div>
          <h3>{agent.name}</h3>
          <div className="row" style={{ gap: 'var(--s-2)', marginTop: 2 }}>
            <span className={`role ${agent.role} badge ${agent.role === 'leader' ? 'accent' : ''}`}>{agent.role}</span>
            {d ? <RunState live={d.live} /> : <AgentStatus agent={agent} compact />}
          </div>
        </div>
        <div className="actions">
          {d && d.live.status === 'working' && <button className="sm" disabled={interrupting} onClick={async () => { if (await interrupt({ projectId, agentId: agent.agentId })) toast(`Interrupted ${agent.name}`); }}><Pause /> Interrupt</button>}
          {d && d.run && d.live.status === 'crashed' && <button className="sm primary" disabled={running} onClick={() => setRun({ projectId, agentId: agent.agentId, run: true })}><RotateCcw /> Restart</button>}
          {d && (d.run
            ? <button className="sm" disabled={running} onClick={async () => { if (await setRun({ projectId, agentId: agent.agentId, run: false })) toast(`Stopped ${agent.name}`); }}><Square /> Stop</button>
            : <button className="sm primary" disabled={running} onClick={async () => { if (await setRun({ projectId, agentId: agent.agentId, run: true })) toast(`Starting ${agent.name}`); }}><Play /> Start</button>)}
          {agent.role === 'worker' && agent.state === 'active' && <button className="sm ghost" disabled={assigning} onClick={async () => { if (await assign({ projectId, agentId: agent.agentId })) toast(`${agent.name} is now the leader`); }}><KeyRound /> Make leader</button>}
        </div>
      </div>
      {d?.live.lastError && d.live.status === 'crashed' && <p className="nudge urgent"><CircleAlert />{d.live.lastError}</p>}
      {d && (
        <div className="metrics">
          <div className="metric"><span className="v">{d.turns}</span><span className="k">turns</span></div>
          <div className="metric"><span className="v">{usd(d.costUsd)}</span><span className="k">cost</span></div>
          <div className="metric"><span className="v">{tokens(d.inputTokens + d.outputTokens)}</span><span className="k">tokens</span></div>
          <div className="metric" style={{ alignContent: 'center' }}><Sparkline values={perTurn} width={110} height={30} label={`${agent.name}: tokens per turn`} /><span className="k">tokens per turn</span></div>
        </div>
      )}
      {agent.next && agent.next.tool !== 'wait' && (
        <p className="next-step"><Sparkles /><span><span className="faint">The board says next:</span> {agent.next.step.length > 240 ? `${agent.next.step.slice(0, 240)}…` : agent.next.step}</span></p>
      )}
      {!d && (
        <div className="panel panel-body small muted">
          {agent.activity ? <><b style={{ color: 'var(--text)' }}>Now:</b> {agent.activity.doing}<br /><b style={{ color: 'var(--text)' }}>Next:</b> {agent.activity.next}</> : 'Joined from a chat: its full session lives in that chat. Activity it reports appears here.'}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, projectId, current, onSelect }: { agent: RosterRecord; projectId: string; current: boolean; onSelect: () => void }) {
  const [assign, busy] = useCommand('leader.assign');
  const now = useNow();
  return (
    <article className="panel agent" aria-current={current ? 'true' : undefined} style={{ padding: 'var(--s-4)', display: 'grid', gap: 'var(--s-3)', borderColor: current ? 'var(--accent-line)' : undefined }}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Avatar name={agent.name} seat={seatOf(agent, now)} leader={agent.role === 'leader'} />
        <div style={{ minWidth: 0 }}>
          <strong className="truncate" style={{ display: 'block' }}>{agent.name}</strong>
          <span className="faint xs">{agent.driven ? `run by the hub · ${agent.client}` : `joined from ${agent.client}`}</span>
        </div>
        <span className="spacer" />
        <span className={`role ${agent.role} badge ${agent.role === 'leader' ? 'accent' : ''}`}>{agent.role}</span>
      </div>
      {agent.driven ? <RunState live={agent.driven.live} /> : <AgentStatus agent={agent} />}
      <p className="small muted">
        {agent.activity ? (<><span className="faint">Now:</span> {agent.activity.doing}<br /><span className="faint">Next:</span> {agent.activity.next}</>)
          : agent.driven ? <span className="num xs">{agent.driven.turns} turn{agent.driven.turns === 1 ? '' : 's'} · {usd(agent.driven.costUsd)}{agent.driven.lastTurnAt ? ` · last ${clock(agent.driven.lastTurnAt)}` : ''}</span>
          : 'No activity reported yet.'}
      </p>
      <div className="row">
        <span className="mono faint xs">{shortId(agent.agentId)}</span>
        <span className="spacer" />
        <button className="sm ghost" onClick={onSelect}>Details</button>
        {agent.role === 'worker' && agent.state === 'active' && (
          <button className="sm" disabled={busy} onClick={() => assign({ projectId, agentId: agent.agentId })}>Make leader</button>
        )}
      </div>
    </article>
  );
}

/**
 * For agents joined from a chat: what the chat is doing, not whether its MCP server is connected
 * (an IDE keeps the server running after a chat stops). An MCP server cannot wake a model.
 */
function AgentStatus({ agent, compact }: { agent: RosterRecord; compact?: boolean }) {
  const now = useNow();
  if (!agent.connected || agent.state !== 'active') return <StateDot state={agent.state} connected={agent.connected} />;
  const seen = agent.attention;
  const hasWork = agent.next && agent.next.tool !== 'wait';
  const stopped = !seen || seen.stopped || (!seen.waiting && now - seen.lastCallAt > STOPPED_AFTER_MS);
  if (!stopped) return <span className="status ok"><span className="dot" aria-hidden />{seen!.waiting ? 'waiting for messages' : 'working'}</span>;
  return (
    <div className="stack" style={{ gap: 'var(--s-2)' }}>
      <span className={`status ${hasWork ? 'bad' : 'warn'}`}><span className="dot" aria-hidden />stopped</span>
      {!compact && (
        <div className={`nudge ${hasWork ? 'urgent' : ''}`} role="status">
          <CircleAlert />
          <span>
            {seen ? `No tool call for ${Math.max(1, Math.round((now - seen.lastCallAt) / 60_000))}m: ` : 'Connected but hasn’t started: '}
            its chat isn’t running. Type “continue” in its chat.
            {hasWork && <span style={{ display: 'block' }}>Work is waiting for it: {agent.next!.step.slice(0, 140)}{agent.next!.step.length > 140 ? '…' : ''}</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// ── activity and conversation ──────────────────────────────────────────────────────────

function iconFor(type: string): { icon: ReactNode; tone?: string } {
  switch (type) {
    case 'human.posted': return { icon: <Send />, tone: 'accent' };
    case 'message.sent': return { icon: <MessageSquare /> };
    case 'roster.joined': return { icon: <UserPlus />, tone: 'good' };
    case 'roster.connected': return { icon: <Radio />, tone: 'good' };
    case 'roster.disconnected': case 'roster.stale': case 'roster.gone': return { icon: <Radio />, tone: 'bad' };
    case 'roster.role_changed': return { icon: <KeyRound />, tone: 'accent' };
    case 'entry.versioned': return { icon: <ListChecks /> };
    case 'task.status_changed': return { icon: <ArrowRight /> };
    case 'change_request.merged': return { icon: <GitMerge />, tone: 'good' };
    case 'agent.turn_finished': return { icon: <Terminal /> };
    default: return { icon: <Activity /> };
  }
}

function ActivityTimeline({ events, name }: { events: LogEvent[]; name: (id: string | null) => string }) {
  const who = (id: string) => (id.startsWith('human:') ? 'You' : id === 'hub' ? 'Hub' : name(id));
  const list = [...events].reverse().slice(0, 200);
  if (list.length === 0) return <div className="empty"><Activity className="empty-icon" /><strong>Nothing has happened yet</strong><p>Joins, messages, board changes, turns and merges show up here as they happen.</p></div>;
  return (
    <div className="panel">
      <ul className="timeline">
        {list.map((e) => {
          const { icon, tone } = iconFor(e.type);
          return (
            <li key={e.gpos}>
              <span className={`ic ${tone ?? ''}`}>{icon}</span>
              <span className="what">{e.type === 'human.posted' || e.type === 'message.sent' ? <><b>{who(String(e.payload.from))}</b>: {String(e.payload.body)}</> : describe(e, who)}</span>
              <time>{clock(e.ts)}</time>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Feed({ events, names }: { events: LogEvent[]; names: Map<string, string> }) {
  const who = (id: string) => (id.startsWith('human:') ? 'You' : id === 'hub' ? 'Hub' : names.get(id) ?? shortId(id));
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const shown = events.filter((e) => e.type !== 'agent.turn_finished');
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  if (shown.length === 0) return <p className="feed faint small">Nothing yet. Messages between you and the agents show up here.</p>;
  return (
    <ol className="feed" aria-live="polite" ref={list} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {shown.map((e) => {
        const p = e.payload;
        if (e.type === 'human.posted' || e.type === 'message.sent') {
          const from = who(String(p.from));
          const priority = String(p.priority);
          const to = p.to === 'all' ? 'everyone' : Array.isArray(p.to) ? (p.to as string[]).map(who).join(', ') : String(p.to);
          return (
            <li key={e.gpos} className={`bubble msg p-${priority} ${from === 'You' ? 'you' : ''} ${priority === 'critical' ? 'critical' : ''}`}>
              <Avatar name={from === 'You' ? 'You' : from} size="xs" />
              <div style={{ minWidth: 0 }}>
                <div className="who msg-meta"><b>{from}</b> → {to}{priority !== 'normal' && <span className={`chip badge ${priority === 'human' ? 'accent' : priority === 'critical' ? 'bad' : ''}`}>{priority}</span>}<time>{clock(e.ts)}</time></div>
                <div className="body msg-body">{String(p.body)}</div>
              </div>
            </li>
          );
        }
        const { icon } = iconFor(e.type);
        return <li key={e.gpos} className="note">{icon}<span>{describe(e, who)}</span></li>;
      })}
    </ol>
  );
}

function describe(e: LogEvent, who: (id: string) => string): string {
  const agent = who(String(e.payload.agentId ?? e.actor));
  switch (e.type) {
    case 'roster.joined': return `${agent} joined as ${String(e.payload.role)}`;
    case 'roster.connected': return `${agent} connected (session ${String(e.payload.epoch)})`;
    case 'roster.disconnected': return `${agent} disconnected`;
    case 'roster.stale': return `${agent} is stale (no connection for 3 minutes)`;
    case 'roster.gone': return `${agent} is gone (grace period over)`;
    case 'roster.role_changed': return `${agent} is now ${String(e.payload.role)}`;
    case 'activity.reported': return `${agent}: ${String(e.payload.doing)} · next: ${String(e.payload.next)}`;
    case 'entry.versioned': return `${String(e.payload.section)} ${Number(e.payload.version) > 1 ? `updated (v${String(e.payload.version)})` : 'added'} by ${e.via === 'human' ? 'you' : who(e.actor)}`;
    case 'task.status_changed': return `Task ${shortId(String(e.payload.taskId))}: ${String(e.payload.from)} → ${String(e.payload.to)} (${String(e.payload.reason)})`;
    case 'change_request.merged': return `Hub merged ${String(e.payload.headSha).slice(0, 8)} into main as ${String(e.payload.mergeSha).slice(0, 8)}`;
    case 'agent.turn_finished': return `${agent} finished a turn${e.payload.ok ? '' : ` (${String(e.payload.error)})`} · ${Math.round(Number(e.payload.durationMs) / 1000)} s${e.payload.costUsd ? ` · ${usd(Number(e.payload.costUsd))}` : ''}`;
    default: return e.type;
  }
}

function Composer({ projectId, agents }: { projectId: string; agents: RosterRecord[] }) {
  const [body, setBody] = useState('');
  const [to, setTo] = useState('all');
  const [post, busy, error] = useCommand('human.post');
  const submit = async () => {
    if (!body.trim()) return;
    const out = await post({ projectId, to: to === 'all' ? 'all' : [to], body: body.trim() });
    if (out) setBody('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="sr-only" htmlFor="composer-body">Instruction</label>
      <textarea id="composer-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} placeholder="Tell the team something. It becomes their next turn and outranks the board." />
      <div className="row">
        <label className="sr-only" htmlFor="composer-to">Send to</label>
        <select id="composer-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="all">Everyone</option>
          {agents.filter((a) => a.state === 'active' || a.state === 'stale').map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </select>
        <span className="kbd">Ctrl ↵</span>
        <button className="primary sm" type="submit" disabled={busy || !body.trim()}><Send /> Send</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export type { Seat };
