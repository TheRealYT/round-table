import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useCommand, useQuery } from '../hub.tsx';
import { clock, shortId, tokens, toolName, usd } from '../format.ts';
import type { LogEvent, ProjectSummary, RosterRecord, RunStatus, TranscriptEntry } from '../types.ts';
import { StateDot } from './Pairing.tsx';
import { BoardPanel } from './Board.tsx';
import { RunState } from './Agents.tsx';

const FEED_TYPES = [
  'human.posted', 'message.sent', 'roster.joined', 'roster.connected', 'roster.disconnected',
  'roster.stale', 'roster.gone', 'roster.role_changed', 'activity.reported',
  'entry.versioned', 'task.status_changed', 'change_request.merged',
];

type Seat = RunStatus | 'warn';

/** One status word for the table, for hub-run and chat-joined agents alike. */
function seatOf(agent: RosterRecord, now: number): Seat {
  if (agent.driven) return agent.driven.live.status;
  if (!agent.connected || agent.state !== 'active') return 'stopped';
  const seen = agent.attention;
  if (!seen || seen.stopped || (!seen.waiting && now - seen.lastCallAt > STOPPED_AFTER_MS)) return 'warn';
  return seen.waiting ? 'idle' : 'working';
}

function useNow(ms = 5_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ProjectView({ project, onSetup }: { project: ProjectSummary; onSetup: () => void }) {
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId: project.projectId }, { pollMs: 3_000 });
  const { data: log } = useQuery<{ events: LogEvent[] }>('logs.query', { projectId: project.projectId, filter: { last: true, types: FEED_TYPES }, limit: 300 });
  const agents = useMemo(() => (roster?.records ?? []).filter((a) => a.state !== 'removed' && a.state !== 'left'), [roster]);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));
  const [selected, setSelected] = useState<string>();
  const current = agents.find((a) => a.agentId === selected) ?? agents.find((a) => a.role === 'leader') ?? agents[0];
  const cost = agents.reduce((n, a) => n + (a.driven?.costUsd ?? 0), 0);

  return (
    <div className="view project">
      <header className="view-header">
        <div>
          <h1>{project.name}</h1>
          <div className="project-facts">
            <span><b className="num">{agents.length}</b> agent{agents.length === 1 ? '' : 's'}</span>
            {cost > 0 && <span><b className="num">{usd(cost)}</b> spent</span>}
            <span className="mono faint">{project.projectId}</span>
          </div>
        </div>
        <div className="actions"><button onClick={onSetup}>Start agents</button></div>
      </header>
      <div className="project-grid">
        <div className="project-main">
          <section aria-labelledby="table-h">
            <div className="section-head"><h2 id="table-h">The table</h2><span className="muted small">Select a seat to see what that agent is doing.</span></div>
            {agents.length === 0 ? (
              <div className="empty">
                <p><strong>No one at the table yet.</strong> Start agents from a provider on the Agents page: the hub runs them and gives each its own worktree.</p>
                <div className="row" style={{ marginTop: 'var(--space-3)' }}><button className="primary" onClick={onSetup}>Start agents</button><span className="small muted">or pair one from a chat on the Pairing page</span></div>
              </div>
            ) : (
              <div className="table-stage">
                <RoundTable agents={agents} selected={current?.agentId} onSelect={setSelected} cost={cost} />
                {current && <AgentDetail agent={current} projectId={project.projectId} />}
              </div>
            )}
          </section>
          {agents.length > 0 && (
            <section aria-label="Agents">
              <div className="section-head"><h2>Roster</h2></div>
              <div className="agents">{agents.map((a) => <AgentCard key={a.agentId} agent={a} projectId={project.projectId} current={a.agentId === current?.agentId} onSelect={() => setSelected(a.agentId)} />)}</div>
            </section>
          )}
          <BoardPanel projectId={project.projectId} />
        </div>
        <aside className="project-side" aria-label="Feed">
          <div className="feed-panel">
            <header><h2>Feed</h2><span className="muted small">messages, joins and board changes</span></header>
            <Feed events={log?.events ?? []} names={names} />
            <Composer projectId={project.projectId} agents={agents} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)).toUpperCase();
}

/** The signature view: seats around a table, the leader at the head, each ringed by its status. */
function RoundTable({ agents, selected, onSelect, cost }: { agents: RosterRecord[]; selected: string | undefined; onSelect: (id: string) => void; cost: number }) {
  const now = useNow();
  const ordered = [...agents].sort((a, b) => (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : 0));
  const seats = ordered.map((a) => seatOf(a, now));
  const working = seats.filter((s) => s === 'working').length;
  const attention = seats.filter((s) => s === 'crashed' || s === 'warn').length;
  return (
    <div>
      <div className="roundtable" role="group" aria-label="Seats">
        <div className="roundtable-top" aria-hidden>
          <span className="big">{working}/{agents.length}</span>
          <span className="small">working</span>
          {cost > 0 && <span className="small num">{usd(cost)}</span>}
        </div>
        {ordered.map((a, i) => {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / ordered.length;
          const seat = seats[i]!;
          return (
            <button
              key={a.agentId}
              className={`seat ${seat}`}
              style={{ left: `${50 + 38 * Math.cos(angle)}%`, top: `${50 + 38 * Math.sin(angle)}%` }}
              aria-pressed={a.agentId === selected}
              aria-label={`${a.name}, ${a.role}, ${seat === 'warn' ? 'stopped calling tools' : seat}`}
              onClick={() => onSelect(a.agentId)}
            >
              {a.role === 'leader' && (
                <svg className="crown" viewBox="0 0 18 12" aria-hidden><path d="M1 11h16L15 3l-4 4-2-6-2 6-4-4z" fill="currentColor" /></svg>
              )}
              <span className="initials" aria-hidden>{initials(a.name)}</span>
              <span className="seat-name">{a.name}</span>
            </button>
          );
        })}
      </div>
      <div className="legend small" aria-hidden>
        <span className="state working"><span className="dot" />working</span>
        <span className="state idle"><span className="dot" />idle</span>
        <span className="state stopped"><span className="dot" />stopped</span>
        <span className="state crashed"><span className="dot" />needs you</span>
      </div>
      {attention > 0 && <p className="nudge urgent" style={{ marginTop: 'var(--space-3)' }}>{attention} agent{attention === 1 ? ' needs' : 's need'} you: see the red seats.</p>}
    </div>
  );
}

function AgentDetail({ agent, projectId }: { agent: RosterRecord; projectId: string }) {
  const d = agent.driven;
  const { data } = useQuery<{ entries: TranscriptEntry[] }>('agent.transcript', d ? { projectId, agentId: agent.agentId } : undefined, { pollMs: 2_000 });
  const [setRun, running] = useCommand('agent.run');
  const [interrupt, interrupting] = useCommand('agent.interrupt');
  const [assign, assigning] = useCommand('leader.assign');
  const list = useRef<HTMLOListElement>(null);
  const entries = data?.entries ?? [];
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, agent.agentId]);
  return (
    <div className="agent-detail" aria-label={`${agent.name} details`}>
      <div className="agent-detail-head">
        <h3>{agent.name}</h3>
        <span className={`role ${agent.role}`}>{agent.role}</span>
        {d ? <RunState live={d.live} /> : <AgentStatus agent={agent} />}
        <span className="spacer" />
        {d && d.live.status === 'working' && <button className="small" disabled={interrupting} onClick={() => interrupt({ projectId, agentId: agent.agentId })}>Interrupt</button>}
        {d && (d.run
          ? <button className="small" disabled={running} onClick={() => setRun({ projectId, agentId: agent.agentId, run: false })}>Stop</button>
          : <button className="small primary" disabled={running} onClick={() => setRun({ projectId, agentId: agent.agentId, run: true })}>Start</button>)}
        {d && d.run && d.live.status === 'crashed' && <button className="small primary" disabled={running} onClick={() => setRun({ projectId, agentId: agent.agentId, run: true })}>Restart</button>}
        {agent.role === 'worker' && agent.state === 'active' && <button className="small" disabled={assigning} onClick={() => assign({ projectId, agentId: agent.agentId })}>Make leader</button>}
      </div>
      {d?.live.lastError && d.live.status === 'crashed' && <p className="nudge urgent">{d.live.lastError}</p>}
      {d && (
        <div className="metrics">
          <div className="metric"><span className="v">{d.turns}</span><span className="k">turns</span></div>
          <div className="metric"><span className="v">{usd(d.costUsd)}</span><span className="k">cost</span></div>
          <div className="metric"><span className="v">{tokens(d.inputTokens + d.outputTokens)}</span><span className="k">tokens</span></div>
          {d.live.tool && <div className="metric"><span className="v">{toolName(d.live.tool)}</span><span className="k">using now</span></div>}
        </div>
      )}
      {agent.next && agent.next.tool !== 'wait' && <p className="small"><span className="faint">Board says next:</span> {agent.next.step.length > 220 ? `${agent.next.step.slice(0, 220)}…` : agent.next.step}</p>}
      {d ? (
        entries.length === 0 ? <p className="muted small">No steps yet.</p> : (
          <ol className="transcript" ref={list} aria-label={`${agent.name} transcript`}>
            {entries.map((e, i) => (
              <li key={i} className={e.kind}>
                <time>{clock(e.at)}</time>
                <span className="body">{e.kind === 'to_agent' ? `→ ${e.text}` : e.kind === 'tool' ? toolLine(e.text) : e.text}</span>
              </li>
            ))}
          </ol>
        )
      ) : (
        <p className="small muted">{agent.activity ? <>Now: {agent.activity.doing} · Next: {agent.activity.next}</> : 'Joined from a chat: its steps show in that chat. Activity it reports appears here.'}</p>
      )}
    </div>
  );
}

function toolLine(text: string): string {
  const space = text.indexOf(' ');
  return space < 0 ? toolName(text) : `${toolName(text.slice(0, space))} ${text.slice(space + 1)}`;
}

function AgentCard({ agent, projectId, current, onSelect }: { agent: RosterRecord; projectId: string; current: boolean; onSelect: () => void }) {
  const [assign, busy] = useCommand('leader.assign');
  return (
    <article className="card agent" aria-current={current ? 'true' : undefined}>
      <div className="agent-head">
        <strong>{agent.name}</strong>
        <span className={`role ${agent.role}`}>{agent.role}</span>
        <span className="spacer" />
        <span className="faint small">{agent.driven ? 'run by the hub' : agent.client}</span>
      </div>
      {agent.driven ? <RunState live={agent.driven.live} /> : <AgentStatus agent={agent} />}
      <p className="small">
        {agent.activity ? (<><span className="muted">Now:</span> {agent.activity.doing}<br /><span className="muted">Next:</span> {agent.activity.next}</>)
          : agent.driven ? <span className="muted">{agent.driven.turns} turn{agent.driven.turns === 1 ? '' : 's'} · {usd(agent.driven.costUsd)}{agent.driven.lastTurnAt ? ` · last turn ${clock(agent.driven.lastTurnAt)}` : ''}</span>
          : <span className="muted">No activity reported yet.</span>}
      </p>
      <div className="agent-foot">
        <span className="mono faint small">{shortId(agent.agentId)}</span>
        <button className="small ghost" onClick={onSelect}>Details</button>
        {agent.role === 'worker' && agent.state === 'active' && (
          <button className="small" disabled={busy} onClick={() => assign({ projectId, agentId: agent.agentId })}>Make leader</button>
        )}
      </div>
    </article>
  );
}

/** No tool call for this long (outside wait) means the agent's chat isn't running. */
const STOPPED_AFTER_MS = 90_000;

/**
 * For agents joined from a chat: what the chat is doing, not whether its MCP server is connected
 * (an IDE keeps the server running after a chat stops). An MCP server cannot wake a model.
 */
function AgentStatus({ agent }: { agent: RosterRecord }) {
  const now = useNow();
  if (!agent.connected || agent.state !== 'active') return <StateDot state={agent.state} connected={agent.connected} />;
  const seen = agent.attention;
  const hasWork = agent.next && agent.next.tool !== 'wait';
  const stopped = !seen || seen.stopped || (!seen.waiting && now - seen.lastCallAt > STOPPED_AFTER_MS);
  if (!stopped) {
    return <span className="state ok"><span className="dot" aria-hidden />{seen!.waiting ? 'waiting for messages' : 'working'}</span>;
  }
  return (
    <div>
      <span className={`state ${hasWork ? 'bad' : 'warn'}`}><span className="dot" aria-hidden />stopped</span>
      <div className={`nudge ${hasWork ? 'urgent' : ''}`} role="status">
        {seen ? `No tool call for ${Math.max(1, Math.round((now - seen.lastCallAt) / 60_000))}m: ` : 'Connected but hasn’t started: '}
        its chat isn’t running. Type “continue” in its chat.
        {hasWork && <div className="small">Work is waiting for it: {agent.next!.step.slice(0, 140)}{agent.next!.step.length > 140 ? '…' : ''}</div>}
      </div>
    </div>
  );
}

function Feed({ events, names }: { events: LogEvent[]; names: Map<string, string> }) {
  const who = (id: string) => (id.startsWith('human:') ? 'You' : id === 'hub' ? 'Hub' : names.get(id) ?? shortId(id));
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  // Follow new events while the reader is at the bottom; leave the scroll alone if they scrolled up.
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  if (events.length === 0) return <p className="feed muted small">Nothing yet. Messages between you and the agents show up here.</p>;
  return (
    <ol
      className="feed"
      aria-live="polite"
      ref={list}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events.map((e) => {
        const p = e.payload;
        if (e.type === 'human.posted' || e.type === 'message.sent') {
          const priority = String(p.priority);
          const to = p.to === 'all' ? 'everyone' : Array.isArray(p.to) ? (p.to as string[]).map(who).join(', ') : String(p.to);
          return (
            <li key={e.gpos} className={`msg p-${priority}`}>
              <div className="msg-meta"><strong>{who(String(p.from))}</strong> → {to} {priority !== 'normal' && <span className={`chip ${priority}`}>{priority}</span>} <time>{clock(e.ts)}</time></div>
              <div className="msg-body">{String(p.body)}</div>
            </li>
          );
        }
        return (
          <li key={e.gpos} className="note">
            <time>{clock(e.ts)}</time>{describe(e, who)}
          </li>
        );
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
      <textarea id="composer-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} placeholder="Tell the team something. It outranks the board." />
      <div className="row">
        <label className="sr-only" htmlFor="composer-to">Send to</label>
        <select id="composer-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="all">Everyone</option>
          {agents.filter((a) => a.state === 'active' || a.state === 'stale').map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </select>
        <span className="hint">Ctrl+Enter</span>
        <button className="primary" type="submit" disabled={busy || !body.trim()}>Send</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

