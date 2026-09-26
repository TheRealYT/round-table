import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useCommand, useQuery } from '../hub.tsx';
import { clock, shortId } from '../format.ts';
import type { LogEvent, ProjectSummary, RosterRecord } from '../types.ts';
import { StateDot } from './Pairing.tsx';
import { BoardPanel } from './Board.tsx';

const FEED_TYPES = [
  'human.posted', 'message.sent', 'roster.joined', 'roster.connected', 'roster.disconnected',
  'roster.stale', 'roster.gone', 'roster.role_changed', 'activity.reported',
  'entry.versioned', 'task.status_changed', 'change_request.merged',
];

export function ProjectView({ project }: { project: ProjectSummary }) {
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId: project.projectId });
  const { data: log } = useQuery<{ events: LogEvent[] }>('logs.query', { projectId: project.projectId, filter: { last: true, types: FEED_TYPES }, limit: 300 });
  const agents = roster?.records ?? [];
  const names = new Map(agents.map((a) => [a.agentId, a.name]));

  return (
    <div className="view project">
      <header className="view-header">
        <h1>{project.name}</h1>
        <p className="muted mono small">{project.projectId}</p>
      </header>
      <section aria-label="Agents">
        <h2>Agents</h2>
        {agents.length === 0 ? (
          <p className="empty">No agents yet. Allow one from Pairing.</p>
        ) : (
          <div className="agents">{agents.map((a) => <AgentCard key={a.agentId} agent={a} projectId={project.projectId} />)}</div>
        )}
      </section>
      <BoardPanel projectId={project.projectId} />
      <section className="feed-section" aria-label="Feed">
        <h2>Feed</h2>
        <Feed events={log?.events ?? []} names={names} />
        <Composer projectId={project.projectId} agents={agents} />
      </section>
    </div>
  );
}

function AgentCard({ agent, projectId }: { agent: RosterRecord; projectId: string }) {
  const [assign, busy] = useCommand('leader.assign');
  return (
    <article className="card agent">
      <div className="agent-head">
        <strong>{agent.name}</strong>
        <span className={`role ${agent.role}`}>{agent.role}</span>
      </div>
      <StateDot state={agent.state} connected={agent.connected} />
      <p className="small">
        {agent.activity ? (<><span className="muted">Now:</span> {agent.activity.doing}<br /><span className="muted">Next:</span> {agent.activity.next}</>) : <span className="muted">No activity reported yet.</span>}
      </p>
      <div className="agent-foot">
        <span className="mono muted small">{shortId(agent.agentId)}</span>
        {agent.role === 'worker' && agent.state === 'active' && (
          <button className="small" disabled={busy} onClick={() => assign({ projectId, agentId: agent.agentId })}>Make leader</button>
        )}
      </div>
    </article>
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
  if (events.length === 0) return <p className="empty">Nothing yet.</p>;
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
              <div className="msg-meta"><strong>{who(String(p.from))}</strong> → {to} <span className={`chip ${priority}`}>{priority}</span> <time className="muted">{clock(e.ts)}</time></div>
              <div className="msg-body">{String(p.body)}</div>
            </li>
          );
        }
        return (
          <li key={e.gpos} className="note">
            <span className="muted">{clock(e.ts)}</span> {describe(e, who)}
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
      <label className="sr-only" htmlFor="composer-to">Send to</label>
      <select id="composer-to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="all">Everyone</option>
        {agents.filter((a) => a.state === 'active' || a.state === 'stale').map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
      </select>
      <label className="sr-only" htmlFor="composer-body">Instruction</label>
      <textarea id="composer-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onKey} placeholder="Instruction to the team (human priority). Ctrl+Enter to send." />
      <button className="primary" type="submit" disabled={busy || !body.trim()}>Send</button>
      {error && <p className="error">{error}</p>}
      <p className="muted small hint">Delivered at human priority: agents see it at their next Round Table call.</p>
    </form>
  );
}

