import { useEffect, useId, useState } from 'react';
import { useCommand, useQuery } from '../hub.tsx';
import { shortId } from '../format.ts';

interface Entry {
  id: string;
  version: number;
  data: Record<string, unknown>;
}

interface Overview {
  boardVersion: number;
  project: { projectId: string; name: string; repo: string | null };
  goal: Entry | null;
  rules: Entry | null;
  taskCounts: Record<string, number>;
  tasks: Array<{ taskId: string; title: string; status: string; owner: string | null }>;
  roster: Array<{ agentId: string; name: string }>;
  openTickets: number;
}

interface Change {
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

const COLUMNS = ['proposed', 'ready', 'claimed', 'in_progress', 'in_review', 'in_test', 'done'] as const;

/** S2 board: setup (repo, test command, goal), tasks by status with plan approval, change requests. */
export function BoardPanel({ projectId }: { projectId: string }) {
  const { data: view } = useQuery<Overview>('board_view', { view: 'overview', projectId });
  const { data: changes } = useQuery<{ records: Change[] }>('board_read', { section: 'artifacts', projectId, limit: 50 });
  if (!view) return null;
  const names = new Map(view.roster.map((r) => [r.agentId, r.name]));
  const name = (id: string | null) => (id ? names.get(id) ?? shortId(id) : '—');
  const complete = Boolean(view.goal && view.project.repo && view.rules?.data.testCommand);
  const setup = (
    <div className="setup">
      <GoalForm projectId={projectId} goal={view.goal} />
      <RepoForm projectId={projectId} repo={view.project.repo} />
      <TestCommandForm projectId={projectId} rules={view.rules} />
    </div>
  );
  return (
    <>
      {!complete && (
        <section aria-label="Setup">
          <div className="section-head"><h2>Set up the project</h2><span className="muted small">Agents work toward the goal, in worktrees of the repository; the hub runs the test command before every merge.</span></div>
          {setup}
        </section>
      )}
      <TasksBoard projectId={projectId} view={view} name={name} />
      <section aria-label="Change requests">
        <div className="section-head"><h2>Change requests</h2></div>
        {(changes?.records ?? []).length === 0 ? (
          <p className="empty">None yet. Workers open one per task once they have commits on the task branch.</p>
        ) : (
          <div className="table-wrap"><table className="table changes">
            <thead>
              <tr><th>Task</th><th>Branch @ head</th><th>Review</th><th>Tests</th><th>Hub run</th><th>Status</th></tr>
            </thead>
            <tbody>
              {changes!.records.map((c) => {
                const atHead = <T extends { headSha: string }>(xs: T[]) => xs.filter((x) => x.headSha === c.headSha);
                const run = c.hubRuns.at(-1);
                return (
                  <tr key={c.changeRequestId}>
                    <td>{c.title}<div className="muted small">by {name(c.author)}</div></td>
                    <td className="mono small">{c.branch} @ {c.headSha.slice(0, 8)}</td>
                    <td>{atHead(c.reviews).map((r, i) => <Verdict key={i} ok={r.verdict === 'approved'} who={name(r.by)} />)}</td>
                    <td>{atHead(c.testResults).map((r, i) => <Verdict key={i} ok={r.status === 'pass'} who={name(r.by)} />)}</td>
                    <td>{run ? <span className={`chip ${run.status === 'pass' ? 'ok' : 'bad'}`} title={run.outputTail}>{run.status}</span> : <span className="muted">—</span>}</td>
                    <td>{c.status === 'merged' ? <span className="chip ok">merged {c.mergeSha?.slice(0, 8)}</span> : c.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
      {complete && (
        <section aria-label="Setup">
          <details>
            <summary className="section-head" style={{ cursor: 'pointer' }}><h2 style={{ display: 'inline' }}>Project setup</h2> <span className="muted small">goal v{view.goal?.version}, {view.project.repo}, <code>{String(view.rules?.data.testCommand)}</code></span></summary>
            {setup}
          </details>
        </section>
      )}
    </>
  );
}

function Verdict({ ok, who }: { ok: boolean; who: string }) {
  return <div className={`verdict ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'} {who}</div>;
}

function TasksBoard({ projectId, view, name }: { projectId: string; view: Overview; name: (id: string | null) => string }) {
  const [approve, approving, error] = useCommand('plan.approve');
  const proposed = view.taskCounts.proposed ?? 0;
  return (
    <section aria-label="Tasks">
      <div className="section-head">
        <h2>Tasks</h2>
        {view.openTickets > 0 && <span className="muted small">{view.openTickets} proposal{view.openTickets === 1 ? '' : 's'} waiting for the leader</span>}
        {proposed > 0 && (
          <div className="actions">
            <button className="primary" disabled={approving} onClick={() => approve({ projectId })}>
              Approve plan ({proposed} proposed)
            </button>
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {view.tasks.length === 0 ? (
        <p className="empty">No tasks yet. Agents propose tasks; the leader commits them; you approve the plan.</p>
      ) : (
        <div className="kanban">
          {COLUMNS.filter((c) => view.tasks.some((t) => t.status === c)).map((column) => (
            <div key={column} className="column" aria-label={column}>
              <h3>{column.replace('_', ' ')} <span className="muted">{view.taskCounts[column]}</span></h3>
              {view.tasks.filter((t) => t.status === column).map((t) => (
                <article key={t.taskId} className="card task">
                  <div>{t.title}</div>
                  <div className="muted small">{t.owner ? name(t.owner) : 'unclaimed'} · <span className="mono">{shortId(t.taskId)}</span></div>
                </article>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GoalForm({ projectId, goal }: { projectId: string; goal: Entry | null }) {
  const id = useId();
  const current = (goal?.data.objective as string | undefined) ?? '';
  const [objective, setObjective] = useState(current);
  useEffect(() => setObjective(current), [current]);
  const [save, saving, error] = useCommand('goal.set');
  return (
    <form className="card setup-item" onSubmit={(e) => { e.preventDefault(); void save({ projectId, goal: { objective: objective.trim() } }); }}>
      <label htmlFor={`${id}-goal`}>Goal {goal && <span className="muted small">v{goal.version}</span>}</label>
      <textarea id={`${id}-goal`} rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should the team deliver?" />
      <button type="submit" disabled={saving || !objective.trim() || objective.trim() === current}>{goal ? 'Update goal' : 'Set goal'}</button>
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
  if (repo) {
    return (
      <div className="card setup-item">
        <span className="label">Repository</span>
        <div className="mono small">{repo}</div>
        {warning && <p className="warning small">{warning}</p>}
      </div>
    );
  }
  return (
    <form
      className="card setup-item"
      onSubmit={async (e) => {
        e.preventDefault();
        const out = await attach({ projectId, path: path.trim(), mainBranch: main.trim() || 'main' });
        setWarning(out?.warning);
      }}
    >
      <label htmlFor={`${id}-repo`}>Repository path</label>
      <input id={`${id}-repo`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/repo" />
      <label htmlFor={`${id}-main`}>Main branch</label>
      <input id={`${id}-main`} value={main} onChange={(e) => setMain(e.target.value)} />
      <button type="submit" disabled={attaching || !path.trim()}>Attach</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function TestCommandForm({ projectId, rules }: { projectId: string; rules: Entry | null }) {
  const id = useId();
  const current = (rules?.data.testCommand as string | undefined) ?? '';
  const [command, setCommand] = useState(current);
  useEffect(() => setCommand(current), [current]);
  const [save, saving, error] = useCommand('rules.edit');
  return (
    <form className="card setup-item" onSubmit={(e) => { e.preventDefault(); void save({ projectId, rules: { ...(rules?.data ?? {}), testCommand: command.trim() } }); }}>
      <label htmlFor={`${id}-test`}>Test command</label>
      <input id={`${id}-test`} className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm ci && npm test" />
      <p className="muted small">The hub runs it on main + the change before merging.</p>
      <button type="submit" disabled={saving || !command.trim() || command.trim() === current}>Save</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
