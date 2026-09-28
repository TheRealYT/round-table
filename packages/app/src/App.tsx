import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Bot, FolderGit2, LayoutDashboard, Link, Plus, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCommand, useHubStatus, useQuery } from './hub.tsx';
import type { PairingRequest, ProjectSummary, ProviderList } from './types.ts';
import { ThemeSwitch, useToast } from './ui.tsx';
import { AgentsView } from './views/Agents.tsx';
import { OverviewView } from './views/Overview.tsx';
import { PairingView } from './views/Pairing.tsx';
import { ProjectView } from './views/Project.tsx';
import { SettingsView } from './views/Settings.tsx';

export type Route = { view: 'overview' } | { view: 'agents' } | { view: 'pairing' } | { view: 'settings' } | { view: 'project'; projectId: string; tab?: string };

function readRoute(): Route {
  const m = /^#\/project\/([^/]+)(?:\/(\w+))?$/.exec(location.hash);
  if (m?.[1]) return { view: 'project', projectId: decodeURIComponent(m[1]), ...(m[2] && { tab: m[2] }) };
  if (location.hash === '#/pairing') return { view: 'pairing' };
  if (location.hash === '#/agents') return { view: 'agents' };
  if (location.hash === '#/settings') return { view: 'settings' };
  return { view: 'overview' };
}

export function hashOf(r: Route): string {
  return r.view === 'project' ? `#/project/${encodeURIComponent(r.projectId)}${r.tab ? `/${r.tab}` : ''}` : `#/${r.view}`;
}

export function go(r: Route): void {
  location.hash = hashOf(r);
}

export function App() {
  const status = useHubStatus();
  const [route, setRoute] = useState<Route>(readRoute);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (status.kind === 'closed' && status.reason === 'unauthenticated') return <LoggedOut />;
  return (
    <div className="shell">
      <Sidebar route={route} onSearch={() => setPalette(true)} />
      <main className="main">
        {status.kind !== 'open' ? (
          <div className="page"><p className="muted">{status.kind === 'connecting' ? 'Connecting to the hub…' : `Hub unreachable (${status.reason}). Retrying…`}</p></div>
        ) : route.view === 'overview' ? (
          <OverviewView />
        ) : route.view === 'agents' ? (
          <AgentsView />
        ) : route.view === 'settings' ? (
          <SettingsView />
        ) : route.view === 'pairing' ? (
          <PairingView onOpenProject={(projectId) => go({ view: 'project', projectId })} />
        ) : (
          <ProjectRoute projectId={route.projectId} tab={route.tab} />
        )}
      </main>
      {status.kind === 'open' && <CommandPalette open={palette} onClose={() => setPalette(false)} />}
    </div>
  );
}

function ProjectRoute({ projectId, tab }: { projectId: string; tab: string | undefined }) {
  const { data } = useQuery<ProjectSummary[]>('project.list', {});
  const project = data?.find((p) => p.projectId === projectId);
  if (!data) return null;
  if (!project) return <div className="page"><p className="empty">No such project.</p></div>;
  return <ProjectView key={project.projectId} project={project} tab={tab ?? 'table'} />;
}

/** The mark: a round table, the leader's seat in amber. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="5.8" fill="var(--wood-1)" stroke="var(--rim)" strokeWidth="1.4" />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle key={a} cx={12 + 9.4 * Math.cos(((a - 90) * Math.PI) / 180)} cy={12 + 9.4 * Math.sin(((a - 90) * Math.PI) / 180)} r="2.1" fill={a === 0 ? 'var(--accent)' : 'var(--text-muted)'} />
      ))}
    </svg>
  );
}

function Sidebar({ route, onSearch }: { route: Route; onSearch: () => void }) {
  const status = useHubStatus();
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const { data: pairing } = useQuery<{ requests: PairingRequest[] }>('pairing.list', {});
  const { data: providers } = useQuery<ProviderList>('provider.list', {}, { pollMs: 4_000 });
  const pending = pairing?.requests.filter((r) => r.status === 'pending').length ?? 0;
  const hubAgents = (providers?.providers ?? []).flatMap((p) => p.agents);
  const running = hubAgents.filter((a) => a.run).length;
  const nav = (r: Route, icon: ReactNode, label: string, extra?: ReactNode) => {
    const active = route.view === r.view;
    return (
      <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => go(r)}>
        {icon}
        {label}
        {extra}
      </button>
    );
  };
  const [adding, setAdding] = useState(false);

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand"><BrandMark /> Round Table</div>
      <button className="search-btn" onClick={onSearch}>
        <Search /> Search <span className="kbd">Ctrl K</span>
      </button>
      {nav({ view: 'overview' }, <LayoutDashboard />, 'Overview')}
      {nav({ view: 'agents' }, <Bot />, 'Agents', running > 0 ? <span className="count-badge count" title={`${running} running`}>{running}</span> : undefined)}
      {/* Pairing is for agents joining from a chat window; it shows when a request waits or you are there. */}
      {(pending > 0 || route.view === 'pairing') && nav({ view: 'pairing' }, <Link />, 'Pairing', pending > 0 ? <span className="count-badge hot count" title={`${pending} waiting`}>{pending}</span> : undefined)}
      {nav({ view: 'settings' }, <SettingsIcon />, 'Settings')}
      <div className="nav-label">
        Projects
        <button className="ghost icon sm" aria-label="New project" title="New project" onClick={() => setAdding(true)}><Plus /></button>
      </div>
      {adding && <NewProject onDone={() => setAdding(false)} />}
      {(projects ?? []).map((p) => {
        const active = route.view === 'project' && route.projectId === p.projectId;
        const mine = hubAgents.filter((a) => a.projectId === p.projectId);
        return (
          <button key={p.projectId} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => go({ view: 'project', projectId: p.projectId })}>
            <FolderGit2 />
            <span className="truncate">{p.name}</span>
            <span className="project-dots" aria-label={`${p.agents} agents`}>
              {mine.length > 0
                ? mine.slice(0, 5).map((a) => <i key={a.agentId} style={{ background: `var(--${a.live?.status ?? 'stopped'})` }} />)
                : <span className="faint xs num">{p.agents || ''}</span>}
            </span>
          </button>
        );
      })}
      {(projects ?? []).length === 0 && !adding && <p className="faint xs" style={{ padding: '0 var(--s-2)' }}>No projects yet.</p>}
      <div className="sidebar-foot">
        <span className="hub-status"><span className={`pill-dot ${status.kind === 'open' ? 'on' : status.kind === 'closed' ? 'off' : ''}`} />{status.kind === 'open' ? 'Hub connected' : status.kind === 'connecting' ? 'Connecting…' : 'Hub unreachable'}</span>
        <span className="spacer" />
        <ThemeSwitch />
      </div>
    </nav>
  );
}

export function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [create, creating] = useCommand<{ projectId: string }>('project.create');
  const toast = useToast();
  return (
    <form
      className="row"
      style={{ padding: '0 var(--s-1) var(--s-2)', flexWrap: 'nowrap' }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const out = await create({ name: name.trim() });
        if (out) {
          toast(`Created ${name.trim()}`);
          onDone();
          go({ view: 'project', projectId: out.projectId, tab: 'setup' });
        }
      }}
    >
      <label className="sr-only" htmlFor="new-project">New project name</label>
      <input id="new-project" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} placeholder="Project name" style={{ minHeight: 30, height: 30 }} />
      <button type="submit" className="sm" disabled={creating || !name.trim()}>Add</button>
    </form>
  );
}

// ── command palette ───────────────────────────────────────────────────────────────────

interface Cmd { group: string; label: string; icon: ReactNode; run: () => void; hint?: string }

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const [create] = useCommand<{ projectId: string }>('project.create');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ('');
      setSel(0);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [
      { group: 'Go to', label: 'Overview', icon: <LayoutDashboard />, run: () => go({ view: 'overview' }) },
      { group: 'Go to', label: 'Agents and providers', icon: <Bot />, run: () => go({ view: 'agents' }) },
      { group: 'Go to', label: 'Pairing (agents from a chat window)', icon: <Link />, run: () => go({ view: 'pairing' }) },
      { group: 'Go to', label: 'Settings', icon: <SettingsIcon />, run: () => go({ view: 'settings' }) },
      ...(projects ?? []).map((p) => ({ group: 'Projects', label: p.name, icon: <FolderGit2 />, hint: `${p.agents} agents`, run: () => go({ view: 'project', projectId: p.projectId }) })),
      ...(projects ?? []).map((p) => ({ group: 'Actions', label: `Start agents in ${p.name}`, icon: <Bot />, run: () => go({ view: 'project', projectId: p.projectId, tab: 'table' }) })),
    ];
    if (q.trim()) list.unshift({ group: 'Actions', label: `Create project “${q.trim()}”`, icon: <Plus />, run: async () => {
      const out = await create({ name: q.trim() });
      if (out) go({ view: 'project', projectId: out.projectId, tab: 'setup' });
    } });
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((c) => c.label.toLowerCase().includes(needle) || c.group === 'Actions' && c.label.startsWith('Create')) : list;
  }, [projects, q, create]);

  const pick = (c: Cmd | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  let group = '';
  return (
    <dialog ref={ref} className="palette" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Command palette">
      <div className="palette-input">
        <Search />
        <input
          autoFocus
          value={q}
          placeholder="Go to a project, page or action…"
          aria-label="Search commands"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, cmds.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); pick(cmds[sel]); }
          }}
        />
        <span className="kbd">Esc</span>
      </div>
      <ul className="palette-list" role="listbox">
        {cmds.map((c, i) => {
          const head = c.group !== group ? (group = c.group) : null;
          return (
            <li key={`${c.group}-${c.label}`}>
              {head && <div className="group">{head}</div>}
              <button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(c)}>
                {c.icon}
                {c.label}
                {c.hint ? <span className="hint">{c.hint}</span> : <ArrowRight className="hint" style={{ marginLeft: 'auto', opacity: i === sel ? 1 : 0 }} />}
              </button>
            </li>
          );
        })}
        {cmds.length === 0 && <li className="group">Nothing matches.</li>}
      </ul>
    </dialog>
  );
}

function LoggedOut() {
  return (
    <div className="logged-out panel">
      <div className="brand"><BrandMark /> Round Table</div>
      <h1>You are not logged in to this hub.</h1>
      <p className="muted">Open the one-time login link printed by <code>rt hub start</code>, or run <code>rt hub login</code> for a new one. Links work once and expire after 10 minutes.</p>
    </div>
  );
}
