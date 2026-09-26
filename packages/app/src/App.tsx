import { useEffect, useState } from 'react';
import { useCommand, useHubStatus, useQuery } from './hub.tsx';
import type { PairingRequest, ProjectSummary } from './types.ts';
import { PairingView } from './views/Pairing.tsx';
import { ProjectView } from './views/Project.tsx';

type Route = { view: 'pairing' } | { view: 'project'; projectId: string };

function readRoute(): Route {
  const m = /^#\/project\/(.+)$/.exec(location.hash);
  return m?.[1] ? { view: 'project', projectId: decodeURIComponent(m[1]) } : { view: 'pairing' };
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
    location.hash = r.view === 'project' ? `#/project/${encodeURIComponent(r.projectId)}` : '#/pairing';
  };

  if (status.kind === 'closed' && status.reason === 'unauthenticated') return <LoggedOut />;
  return (
    <div className="shell">
      <Sidebar route={route} go={go} />
      <main className="main">
        {status.kind !== 'open' ? (
          <div className="view"><p className="muted">{status.kind === 'connecting' ? 'Connecting to the hub…' : `Hub unreachable (${status.reason}). Retrying…`}</p></div>
        ) : route.view === 'pairing' ? (
          <PairingView onOpenProject={(projectId) => go({ view: 'project', projectId })} />
        ) : (
          <ProjectRoute projectId={route.projectId} />
        )}
      </main>
    </div>
  );
}

function ProjectRoute({ projectId }: { projectId: string }) {
  const { data } = useQuery<ProjectSummary[]>('project.list', {});
  const project = data?.find((p) => p.projectId === projectId);
  if (!data) return null;
  if (!project) return <div className="view"><p className="empty">No such project.</p></div>;
  return <ProjectView project={project} />;
}

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const status = useHubStatus();
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const { data: pairing } = useQuery<{ requests: PairingRequest[] }>('pairing.list', {});
  const pending = pairing?.requests.filter((r) => r.status === 'pending').length ?? 0;
  const [name, setName] = useState('');
  const [create, creating] = useCommand<{ projectId: string }>('project.create');

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="brand">
        <span className="logo" aria-hidden>◯</span> Round Table
        <span className={`conn ${status.kind}`} title={status.kind === 'open' ? 'Connected to the hub' : 'Not connected'} />
      </div>
      <button className={`nav-item ${route.view === 'pairing' ? 'active' : ''}`} onClick={() => go({ view: 'pairing' })}>
        Pairing {pending > 0 && <span className="badge">{pending}</span>}
      </button>
      <div className="nav-label">Projects</div>
      {(projects ?? []).map((p) => (
        <button key={p.projectId} className={`nav-item ${route.view === 'project' && route.projectId === p.projectId ? 'active' : ''}`} onClick={() => go({ view: 'project', projectId: p.projectId })}>
          <span className="truncate">{p.name}</span> <span className="muted small">{p.agents}</span>
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
      <h1>Round Table</h1>
      <p>You are not logged in to this hub.</p>
      <p className="muted">Open the one-time login link printed by <code>rt hub start</code>. Links expire after 10 minutes; restarting the hub prints a new one.</p>
    </div>
  );
}
