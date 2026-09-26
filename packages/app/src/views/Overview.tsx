import { Bot, CircleAlert, Coins, FolderGit2, GitBranch, Hand, Link, ListChecks, Plus, Zap } from 'lucide-react';
import { useState } from 'react';
import { go, NewProject } from '../App.tsx';
import { useCommand, useQuery } from '../hub.tsx';
import { usd } from '../format.ts';
import type { PairingRequest, ProjectSummary, ProviderList, RosterRecord } from '../types.ts';
import { Avatar, RunState, seatOf, TaskProgress, useNow, useToast } from '../ui.tsx';

interface Overview {
  project: { projectId: string; name: string; repo: string | null };
  goal: { data: { objective?: string } } | null;
  taskCounts: Record<string, number>;
  tasks: Array<{ status: string }>;
  openTickets: number;
}

/** The front page: what needs you, then every project and every running agent at a glance. */
export function OverviewView() {
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const { data: providers } = useQuery<ProviderList>('provider.list', {}, { pollMs: 3_000 });
  const { data: pairing } = useQuery<{ requests: PairingRequest[] }>('pairing.list', {});
  const [adding, setAdding] = useState(false);
  const agents = (providers?.providers ?? []).flatMap((p) => p.agents.map((a) => ({ ...a, kind: p.settings.kind })));
  const running = agents.filter((a) => a.run).length;
  const working = agents.filter((a) => a.live?.status === 'working').length;
  const spend = agents.reduce((n, a) => n + a.costUsd, 0);
  const crashed = agents.filter((a) => a.live?.status === 'crashed');
  const pendingPairing = (pairing?.requests ?? []).filter((r) => r.status === 'pending').length;
  const hour = new Date().getHours();

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}</div>
          <h1>Overview</h1>
          <p className="lede">Everything your agents are doing, and the few things that need you.</p>
        </div>
        <div className="actions">
          <button onClick={() => go({ view: 'agents' })}><Bot /> Agents</button>
          <button className="primary" onClick={() => setAdding(true)}><Plus /> New project</button>
        </div>
      </header>

      <div className="statline" aria-label="Summary">
        <div className="stat"><span className="v">{running}<small>/{agents.length}</small></span><span className="k"><Bot /> agents running</span></div>
        <div className="stat"><span className="v" style={{ color: working ? 'var(--working)' : undefined }}>{working}</span><span className="k"><Zap /> working right now</span></div>
        <div className="stat"><span className="v">{projects?.length ?? 0}</span><span className="k"><FolderGit2 /> projects</span></div>
        <div className="stat"><span className="v">{usd(spend)}</span><span className="k"><Coins /> spent by hub-run agents</span></div>
      </div>

      <section className="section" aria-labelledby="attention-h">
        <div className="section-head"><h2 id="attention-h">Needs you</h2></div>
        <div className="attention">
          {pendingPairing > 0 && (
            <AlertCard icon={<Link />} title={`${pendingPairing} agent${pendingPairing === 1 ? '' : 's'} waiting to pair`} detail="Check the match phrase and allow it." action="Review" onAction={() => go({ view: 'pairing' })} />
          )}
          {crashed.map((a) => (
            <AlertCard key={a.agentId} bad icon={<CircleAlert />} title={`${a.name} crashed`} detail={a.live?.lastError ?? 'Its process exited.'} action="Open" onAction={() => go({ view: 'project', projectId: a.projectId })} />
          ))}
          {(projects ?? []).map((p) => <ProjectAttention key={p.projectId} project={p} />)}
        </div>
        <AllClear show={pendingPairing === 0 && crashed.length === 0} />
      </section>

      {adding && <div className="panel" style={{ padding: 'var(--s-3)', marginBottom: 'var(--s-5)', maxWidth: 420 }}><NewProject onDone={() => setAdding(false)} /></div>}

      <div className="overview-grid">
        <section aria-labelledby="projects-h">
          <div className="section-head"><h2 id="projects-h">Projects</h2></div>
          {(projects ?? []).length === 0 ? (
            <div className="empty">
              <FolderGit2 className="empty-icon" />
              <strong>No projects yet</strong>
              <p>A project is a goal, a repository and a team of agents. Create one, then start agents from a provider.</p>
              <button className="primary" onClick={() => setAdding(true)}><Plus /> New project</button>
            </div>
          ) : (
            <div className="projects-grid">{projects!.map((p) => <ProjectCard key={p.projectId} project={p} />)}</div>
          )}
        </section>
        <section className="panel" aria-labelledby="live-h">
          <div className="panel-head"><Bot /><h2 id="live-h">Hub-run agents</h2><span className="actions"><button className="ghost sm" onClick={() => go({ view: 'agents' })}>Manage</button></span></div>
          {agents.length === 0 ? (
            <div className="panel-body muted small">None yet. Set up a provider on the Agents page and start agents from it.</div>
          ) : (
            <div>
              {agents.map((a) => (
                <div key={a.agentId} className="agent-row">
                  <Avatar name={a.name} seat={a.live?.status ?? 'stopped'} size="xs" />
                  <button className="link truncate" style={{ justifyContent: 'flex-start', color: 'var(--text)', display: 'block', textAlign: 'left' }} onClick={() => go({ view: 'project', projectId: a.projectId })}>
                    {a.name} <span className="faint xs">· {(projects ?? []).find((p) => p.projectId === a.projectId)?.name}</span>
                  </button>
                  <span className="row" style={{ gap: 'var(--s-3)', flexWrap: 'nowrap' }}><RunState live={a.live} /><span className="faint xs num">{usd(a.costUsd)}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AllClear({ show }: { show: boolean }) {
  // Project-level items render themselves; this only covers the global ones.
  return show ? <p className="faint small" style={{ marginTop: 'var(--s-2)' }}>No crashed agents and no one waiting to pair.</p> : null;
}

function AlertCard({ icon, title, detail, action, onAction, bad }: { icon: React.ReactNode; title: string; detail: string; action: string; onAction: () => void; bad?: boolean }) {
  return (
    <div className={`alert-card ${bad ? 'bad' : ''}`}>
      <span className="icon-box">{icon}</span>
      <div style={{ minWidth: 0 }}><strong className="truncate">{title}</strong><span className="truncate" style={{ display: 'block' }}>{detail}</span></div>
      <button className="sm" onClick={onAction}>{action}</button>
    </div>
  );
}

/** A plan waiting for approval, or agents that stopped with work waiting. */
function ProjectAttention({ project }: { project: ProjectSummary }) {
  const { data } = useQuery<Overview>('board_view', { view: 'overview', projectId: project.projectId });
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId: project.projectId }, { pollMs: 10_000 });
  const [approve, approving] = useCommand('plan.approve');
  const toast = useToast();
  const now = useNow();
  const proposed = data?.taskCounts.proposed ?? 0;
  const stuck = (roster?.records ?? []).filter((a) => !a.driven && seatOf(a, now) === 'warn' && a.next && a.next.tool !== 'wait');
  return (
    <>
      {proposed > 0 && (
        <AlertCard
          icon={<ListChecks />}
          title={`Plan ready in ${project.name}`}
          detail={`${proposed} task${proposed === 1 ? '' : 's'} proposed and committed by the leader.`}
          action={approving ? 'Approving…' : 'Approve'}
          onAction={async () => {
            if (await approve({ projectId: project.projectId })) toast(`Plan approved in ${project.name}`);
          }}
        />
      )}
      {stuck.map((a) => (
        <AlertCard key={a.agentId} bad icon={<Hand />} title={`${a.name} stopped with work waiting`} detail="Its chat isn’t running. Type “continue” in its chat." action="Open" onAction={() => go({ view: 'project', projectId: project.projectId })} />
      ))}
    </>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { data } = useQuery<Overview>('board_view', { view: 'overview', projectId: project.projectId });
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId: project.projectId }, { pollMs: 5_000 });
  const now = useNow();
  const agents = (roster?.records ?? []).filter((a) => a.state !== 'removed' && a.state !== 'left');
  const total = data?.tasks.length ?? 0;
  const done = data?.taskCounts.done ?? 0;
  const spend = agents.reduce((n, a) => n + (a.driven?.costUsd ?? 0), 0);
  const workingNow = agents.filter((a) => seatOf(a, now) === 'working').length;
  return (
    <button className="project-card" onClick={() => go({ view: 'project', projectId: project.projectId })}>
      <div className="top">
        <h3 className="truncate">{project.name}</h3>
        <span className="spacer" />
        {workingNow > 0 && <span className="badge good"><Zap /> {workingNow} working</span>}
      </div>
      <p className="goal">{data?.goal?.data.objective ?? 'No goal yet. Open it to set one up.'}</p>
      <TaskProgress counts={data?.taskCounts ?? {}} />
      <div className="foot">
        <span className="avatar-stack">{agents.slice(0, 6).map((a) => <Avatar key={a.agentId} name={a.name} seat={seatOf(a, now)} leader={a.role === 'leader'} size="xs" />)}</span>
        <span className="num">{done}/{total} tasks</span>
        {spend > 0 && <span className="num">{usd(spend)}</span>}
        <span className="spacer" />
        {data?.project.repo && <span className="row" style={{ gap: 4 }} title={data.project.repo}><GitBranch size={13} /> repo</span>}
      </div>
    </button>
  );
}
