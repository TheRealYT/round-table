import { useEffect, useState } from 'react';
import { useCommand, useHubStatus, useQuery } from './hub.tsx';
import type { PairingRequest, ProjectSummary, ProviderList } from './types.ts';
import { AgentsView } from './views/Agents.tsx';
import { PairingView } from './views/Pairing.tsx';
import { ProjectView } from './views/Project.tsx';

type Route = { view: 'agents' } | { view: 'pairing' } | { view: 'project'; projectId: string };

function readRoute(): Route {
  const m = /^#\/project\/(.+)$/.exec(location.hash);
  if (m?.[1]) return { view: 'project', projectId: decodeURIComponent(m[1]) };
  return location.hash === '#/pairing' ? { view: 'pairing' } : { view: 'agents' };
}

function hashOf(r: Route): string {
  return r.view === 'project' ? `#/project/${encodeURIComponent(r.projectId)}` : `#/${r.view}`;
}

export function App() {
  const status = useHubStatus();
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const go = (r: Route) => {
    location.hash = hashOf(r);
  };

  if (status.kind === 'closed' && status.reason === 'unauthenticated') return <LoggedOut />;
  return (
    <div className="shell">
      <Sidebar route={route} go={go} />
      <main className="main">
        {status.kind !== 'open' ? (
          <div className="view"><p className="muted">{status.kind === 'connecting' ? 'Connecting to the hub…' : `Hub unreachable (${status.reason}). Retrying…`}</p></div>
        ) : route.view === 'agents' ? (
          <AgentsView onOpenProject={(projectId) => go({ view: 'project', projectId })} />
        ) : route.view === 'pairing' ? (
          <PairingView onOpenProject={(projectId) => go({ view: 'project', projectId })} />
        ) : (
          <ProjectRoute projectId={route.projectId} go={go} />
        )}
      </main>
    </div>
  );
}

function ProjectRoute({ projectId, go }: { projectId: string; go: (r: Route) => void }) {
  const { data } = useQuery<ProjectSummary[]>('project.list', {});
  const project = data?.find((p) => p.projectId === projectId);
  if (!data) return null;
  if (!project) return <div className="view"><p className="empty">No such project.</p></div>;
  return <ProjectView project={project} onSetup={() => go({ view: 'agents' })} />;
}

/** The mark: a round table with four seats. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="5.5" fill="var(--table-wood)" stroke="var(--accent)" strokeWidth="1.6" />
      {[0, 90, 180, 270].map((a) => (
        <circle key={a} cx={12 + 9.5 * Math.cos(((a - 90) * Math.PI) / 180)} cy={12 + 9.5 * Math.sin(((a - 90) * Math.PI) / 180)} r="2.2" fill={a === 0 ? 'var(--accent)' : 'var(--text-muted)'} />
      ))}
    </svg>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const status = useHubStatus();
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const { data: pairing } = useQuery<{ requests: PairingRequest[] }>('pairing.list', {});
  const { data: providers } = useQuery<ProviderList>('provider.list', {}, { pollMs: 5_000 });
  const pending = pairing?.requests.filter((r) => r.status === 'pending').length ?? 0;
  const running = (providers?.providers ?? []).reduce((n, p) => n + p.running, 0);
  const [name, setName] = useState('');
  const [create, creating] = useCommand<{ projectId: string }>('project.create');

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <BrandMark /> Round Table
        <span className={`conn ${status.kind}`} role="img" aria-label={status.kind === 'open' ? 'Connected to the hub' : 'Not connected to the hub'} title={status.kind === 'open' ? 'Connected to the hub' : 'Not connected'} />
      </div>
      <button className={`nav-item ${route.view === 'agents' ? 'active' : ''}`} aria-current={route.view === 'agents' ? 'page' : undefined} onClick={() => go({ view: 'agents' })}>
        <Icon d="M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13m-.5-2.6c.6-.6 1.5-.9 2.5-.9 1.9 0 3.5 1.5 3.5 3.5" />
        Agents
        {running > 0 && <span className="badge quiet count" title={`${running} running`}>{running}</span>}
      </button>
      <button className={`nav-item ${route.view === 'pairing' ? 'active' : ''}`} aria-current={route.view === 'pairing' ? 'page' : undefined} onClick={() => go({ view: 'pairing' })}>
        <Icon d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1m-2 2-1 1a2.8 2.8 0 0 1-4-4l1-1" />
        Pairing
        {pending > 0 && <span className="badge count" title={`${pending} waiting`}>{pending}</span>}
      </button>
      <div className="nav-label">Projects</div>
      {(projects ?? []).map((p) => (
        <button
          key={p.projectId}
          className={`nav-item ${route.view === 'project' && route.projectId === p.projectId ? 'active' : ''}`}
          aria-current={route.view === 'project' && route.projectId === p.projectId ? 'page' : undefined}
          onClick={() => go({ view: 'project', projectId: p.projectId })}
        >
          <span className="truncate">{p.name}</span> <span className="faint small num count">{p.agents}</span>
        </button>
      ))}
      <form
        className="new-project"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const out = await create({ name: name.trim() });
          if (out) {
            setName('');
            go({ view: 'project', projectId: out.projectId });
          }
        }}
      >
        <label className="sr-only" htmlFor="new-project">New project name</label>
        <input id="new-project" value={name} onChange={(e) => setName(e.target.value)} placeholder="New project…" />
        <button type="submit" disabled={creating || !name.trim()}>Add</button>
      </form>
    </nav>
  );
}

function LoggedOut() {
  return (
    <div className="logged-out">
      <div className="brand"><BrandMark /> Round Table</div>
      <h1>You are not logged in to this hub.</h1>
      <p className="muted">Open the one-time login link printed by <code>rt hub start</code>, or run <code>rt hub login</code> for a new one. Links work once and expire after 10 minutes.</p>
    </div>
  );
}
