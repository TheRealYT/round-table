import { useEffect, useId, useState } from 'react';
import { Check, CircleCheck, CircleX, Crown, FlaskConical, FolderGit2, GitBranch, GitMerge, GitPullRequest, ScrollText, Target, X } from 'lucide-react';
import { useCommand } from '../hub.tsx';
import { shortId } from '../format.ts';
import { Avatar, TASK_COLOR, TASK_COLUMNS, useToast } from '../ui.tsx';

export interface Entry {
  id: string;
  version: number;
  data: Record<string, unknown>;
}

export interface BoardOverview {
  boardVersion: number;
  project: { projectId: string; name: string; repo: string | null };
  goal: Entry | null;
  rules: Entry | null;
  taskCounts: Record<string, number>;
  tasks: Array<{ taskId: string; title: string; status: string; owner: string | null }>;
  roster: Array<{ agentId: string; name: string }>;
  openTickets: number;
}

export interface Change {
  changeRequestId: string;
  title: string | null;
  branch: string;
  author: string;
  headSha: string;
  status: string;
  reviews: Array<{ by: string; verdict: string; headSha: string }>;
  testResults: Array<{ by: string; status: string; headSha: string }>;
  hubRuns: Array<{ headSha: string; status: string; outputTail: string }>;
  mergeSha: string | null;
}

export function setupComplete(view: BoardOverview): boolean {
  return Boolean(view.goal && view.project.repo && view.rules?.data.testCommand);
}

/** Tasks by status, one column per status that has tasks (plus Ready once a plan exists). */
export function Kanban({ view, name }: { view: BoardOverview; name: (id: string | null) => string }) {
  if (view.tasks.length === 0) {
    return (
      <div className="empty">
        <Target className="empty-icon" />
        <strong>No tasks yet</strong>
        <p>Workers propose tasks for the goal, the leader commits them, and you approve the plan. They show up here as they move from ready to done.</p>
      </div>
    );
  }
  return (
    <div className="kanban">
      {TASK_COLUMNS.filter((c) => view.tasks.some((t) => t.status === c)).map((column) => (
        <div key={column} className="column" aria-label={column}>
          <h3><i style={{ background: TASK_COLOR[column] }} />{column.replace('_', ' ')}<span className="count-badge">{view.taskCounts[column]}</span></h3>
          {view.tasks.filter((t) => t.status === column).map((t) => (
            <article key={t.taskId} className="task">
              <div className="title">{t.title}</div>
              <div className="meta">
                {t.owner ? <><Avatar name={name(t.owner)} size="xs" /> {name(t.owner)}</> : <span className="faint">unclaimed</span>}
                <span className="spacer" />
                <span className="mono">{shortId(t.taskId)}</span>
              </div>
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChangesTable({ changes, name }: { changes: Change[]; name: (id: string | null) => string }) {
  if (changes.length === 0) {
    return (
      <div className="empty">
        <GitPullRequest className="empty-icon" />
        <strong>No change requests yet</strong>
        <p>A worker opens one per task once it has commits on the task branch. Another worker reviews and tests it, then the hub runs the test command on main + the change and merges.</p>
      </div>
    );
  }
  return (
    <div className="panel table-wrap">
      <table className="table changes">
        <thead>
          <tr><th>Change</th><th>Branch</th><th>Review</th><th>Tests</th><th>Hub run</th><th>Status</th></tr>
        </thead>
        <tbody>
          {changes.map((c) => {
            const atHead = <T extends { headSha: string }>(xs: T[]) => xs.filter((x) => x.headSha === c.headSha);
            const run = c.hubRuns.at(-1);
            return (
              <tr key={c.changeRequestId}>
                <td><div style={{ fontWeight: 500 }}>{c.title}</div><div className="faint xs row" style={{ gap: 6 }}><Avatar name={name(c.author)} size="xs" /> by {name(c.author)}</div></td>
                <td className="mono xs"><span className="row" style={{ gap: 6 }}><GitBranch size={13} />{c.branch}</span><span className="faint">@ {c.headSha.slice(0, 8)}</span></td>
                <td>{atHead(c.reviews).map((r, i) => <Verdict key={i} ok={r.verdict === 'approved'} who={name(r.by)} />)}{atHead(c.reviews).length === 0 && <span className="faint">—</span>}</td>
                <td>{atHead(c.testResults).map((r, i) => <Verdict key={i} ok={r.status === 'pass'} who={name(r.by)} />)}{atHead(c.testResults).length === 0 && <span className="faint">—</span>}</td>
                <td>{run ? <span className={`badge ${run.status === 'pass' ? 'good' : 'bad'} chip`} title={run.outputTail}>{run.status === 'pass' ? <Check /> : <X />}{run.status}</span> : <span className="faint">—</span>}</td>
                <td>{c.status === 'merged' ? <span className="badge good"><GitMerge />merged {c.mergeSha?.slice(0, 8)}</span> : <span className="badge">{c.status.replace('_', ' ')}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Verdict({ ok, who }: { ok: boolean; who: string }) {
  return <div className={`verdict ${ok ? 'ok' : 'bad'}`}>{ok ? <CircleCheck /> : <CircleX />} {who}</div>;
}

/** Goal, repository, test command: what agents need before they can do real work. */
export function SetupPanel({ projectId, view }: { projectId: string; view: BoardOverview }) {
  return (
    <div className="setup-grid">
      <GoalForm projectId={projectId} goal={view.goal} />
      <RepoForm projectId={projectId} repo={view.project.repo} />
      <RulesForm projectId={projectId} rules={view.rules} />
    </div>
  );
}

function GoalForm({ projectId, goal }: { projectId: string; goal: Entry | null }) {
  const id = useId();
  const current = (goal?.data.objective as string | undefined) ?? '';
  const [objective, setObjective] = useState(current);
  useEffect(() => setObjective(current), [current]);
  const [save, saving, error] = useCommand('goal.set');
  const toast = useToast();
  return (
    <form className="panel setup-card" onSubmit={async (e) => { e.preventDefault(); if (await save({ projectId, goal: { objective: objective.trim() } })) toast('Goal saved: agents are told at once'); }}>
      <div className="setup-title"><Target /> Goal {goal && <span className="faint xs num">v{goal.version}</span>}{goal && <CircleCheck className="done" size={16} />}</div>
      <label htmlFor={`${id}-goal`} className="sr-only">Goal</label>
      <textarea id={`${id}-goal`} rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the team deliver? e.g. Move checkout to a single page with inline address validation." />
      <button type="submit" className={goal ? '' : 'primary'} disabled={saving || !objective.trim() || objective.trim() === current}>{goal ? 'Update goal' : 'Set goal'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function RepoForm({ projectId, repo }: { projectId: string; repo: string | null }) {
  const id = useId();
  const [path, setPath] = useState('');
  const [main, setMain] = useState('main');
  const [attach, attaching, error] = useCommand<{ warning?: string }>('repo.attach');
  const [warning, setWarning] = useState<string>();
  const toast = useToast();
  if (repo) {
    return (
      <div className="panel setup-card">
        <div className="setup-title"><FolderGit2 /> Repository <CircleCheck className="done" size={16} /></div>
        <div className="mono small" style={{ overflowWrap: 'anywhere' }}>{repo}</div>
        <p className="hint">Each agent works in its own git worktree of it. The hub merges into its main branch.</p>
        {warning && <p className="nudge">{warning}</p>}
      </div>
    );
  }
  return (
    <form
      className="panel setup-card"
      onSubmit={async (e) => {
        e.preventDefault();
        const out = await attach({ projectId, path: path.trim(), mainBranch: main.trim() || 'main' });
        if (out) toast('Repository attached');
        setWarning(out?.warning);
      }}
    >
      <div className="setup-title"><FolderGit2 /> Repository</div>
      <div className="field"><label htmlFor={`${id}-repo`}>Repository path</label><input id={`${id}-repo`} className="mono-input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/app" /></div>
      <div className="field"><label htmlFor={`${id}-main`}>Main branch</label><input id={`${id}-main`} className="mono-input" value={main} onChange={(e) => setMain(e.target.value)} /></div>
      <button type="submit" className="primary" disabled={attaching || !path.trim()}>Attach</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Checks the hub runs before merging, and the project's rules for its agents (added to the hub-wide ones). */
function RulesForm({ projectId, rules }: { projectId: string; rules: Entry | null }) {
  const id = useId();
  const data = (rules?.data ?? {}) as { testCommand?: string; text?: string; leaderText?: string };
  const [command, setCommand] = useState(data.testCommand ?? '');
  const [text, setText] = useState(data.text ?? '');
  const [leaderText, setLeaderText] = useState(data.leaderText ?? '');
  useEffect(() => {
    setCommand(data.testCommand ?? '');
    setText(data.text ?? '');
    setLeaderText(data.leaderText ?? '');
  }, [rules?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [save, saving, error] = useCommand('rules.edit');
  const toast = useToast();
  const dirty = command.trim() !== (data.testCommand ?? '') || text !== (data.text ?? '') || leaderText !== (data.leaderText ?? '');
  return (
    <form
      className="panel setup-card rules-card"
      onSubmit={async (e) => {
        e.preventDefault();
        const next = { ...(rules?.data ?? {}), testCommand: command.trim() || undefined, text: text.trim() || undefined, leaderText: leaderText.trim() || undefined };
        if (await save({ projectId, rules: next })) toast('Rules saved: agents are told at once');
      }}
    >
      <div className="setup-title"><ScrollText /> Checks and rules {data.testCommand && <CircleCheck className="done" size={16} />}</div>
      <div className="field">
        <label htmlFor={`${id}-test`}><FlaskConical size={13} /> Check command</label>
        <input id={`${id}-test`} className="mono-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm install && npm test" />
        <span className="hint">The hub runs it on main + each change before merging; a failure keeps main untouched. Installed packages are kept between runs.</span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-rules`}>Rules for every agent in this project</label>
        <textarea id={`${id}-rules`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Plain JavaScript, no frameworks. Don’t touch the deploy folder. Keep each change under 200 lines." />
      </div>
      <div className="field">
        <label htmlFor={`${id}-leader`}><Crown size={13} /> Rules for the leader</label>
        <textarea id={`${id}-leader`} rows={2} value={leaderText} onChange={(e) => setLeaderText(e.target.value)} placeholder="e.g. Plan at most 4 tasks. Ask me before adding anything beyond the goal." />
        <span className="hint">Added to the hub-wide rules in Settings.</span>
      </div>
      <button type="submit" className={data.testCommand ? '' : 'primary'} disabled={saving || !dirty || !command.trim()}>Save</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
