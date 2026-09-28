import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderGit2, GitBranch, GitCommitHorizontal, GitMerge, History, SquareTerminal, ExternalLink, ArrowUp, ArrowDown } from 'lucide-react';
import { useQuery } from '../hub.tsx';
import { clock, timeAgo } from '../format.ts';
import { Avatar, TASK_COLOR } from '../ui.tsx';

/** Read-only git (S2c): branches, history, each agent's worktree and the files, with diffs. */

interface Commit { sha: string; parents: string[]; author: string; at: number; subject: string; refs: string[] }
interface FileStat { path: string; added: number; removed: number }
interface Patch { files: FileStat[]; patch: string; truncated: boolean }
interface Branch { name: string; sha: string; ahead: number; behind: number; last: Commit | null; task: { taskId: string; title: string; status: string; owner: string | null } | null }
interface Worktree { path: string; head: string | null; branch: string | null; detached: boolean; changes: Array<{ status: string; path: string }>; main: boolean; agent: { agentId: string; name: string } | null }

type View = 'branches' | 'history' | 'worktrees' | 'files';

export function CodeTab({ projectId, hasRepo, name, onTerminal }: { projectId: string; hasRepo: boolean; name: (id: string | null) => string; onTerminal: (worktree: string | null) => void }) {
  const [view, setView] = useState<View>('branches');
  const [source, setSource] = useState<{ ref?: string; worktree?: string; label: string }>({ label: 'main' });
  if (!hasRepo) {
    return (
      <div className="empty">
        <FolderGit2 className="empty-icon" />
        <strong>No repository yet</strong>
        <p>Attach one under Setup; then its branches, history, each agent’s worktree and files show up here.</p>
      </div>
    );
  }
  const views: Array<{ id: View; label: string; icon: ReactNode }> = [
    { id: 'branches', label: 'Branches', icon: <GitBranch /> },
    { id: 'history', label: 'History', icon: <History /> },
    { id: 'worktrees', label: 'Worktrees', icon: <FolderGit2 /> },
    { id: 'files', label: 'Files', icon: <FileCode2 /> },
  ];
  return (
    <div className="code">
      <div className="segmented-nav" role="tablist" aria-label="Code">
        {views.map((v) => <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>{v.icon}{v.label}</button>)}
        <span className="spacer" />
        <button className="sm" onClick={() => onTerminal(null)}><SquareTerminal /> Terminal in the repo</button>
      </div>
      {view === 'branches' && <Branches projectId={projectId} name={name} onBrowse={(ref) => { setSource({ ref, label: ref }); setView('files'); }} />}
      {view === 'history' && <HistoryView projectId={projectId} />}
      {view === 'worktrees' && <Worktrees projectId={projectId} onTerminal={onTerminal} onBrowse={(w) => { setSource({ worktree: w.path, label: w.agent ? `${w.agent.name}’s worktree` : w.branch ?? 'worktree' }); setView('files'); }} />}
      {view === 'files' && <Files projectId={projectId} source={source} onSource={setSource} />}
    </div>
  );
}

function Branches({ projectId, name, onBrowse }: { projectId: string; name: (id: string | null) => string; onBrowse: (ref: string) => void }) {
  const { data, error } = useQuery<{ main: string; branches: Branch[] }>('git.branches', { projectId }, { pollMs: 5_000 });
  const [open, setOpen] = useState<string>();
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  return (
    <div className="panel">
      <ul className="git-list">
        {data.branches.map((b) => (
          <li key={b.name}>
            <button className="git-row" aria-expanded={open === b.name} onClick={() => setOpen(open === b.name ? undefined : b.name)}>
              {open === b.name ? <ChevronDown /> : <ChevronRight />}
              <span className="git-main">
                <span className="row" style={{ gap: 'var(--s-2)' }}>
                  <GitBranch size={14} /><span className="mono strong">{b.name}</span>
                  {b.name === data.main && <span className="badge chip good">main</span>}
                  {b.task && <span className="badge chip" style={{ borderColor: TASK_COLOR[b.task.status] }}><i className="dot" style={{ background: TASK_COLOR[b.task.status] }} />{b.task.status.replace('_', ' ')}</span>}
                </span>
                <span className="small muted">{b.task ? `${b.task.title}${b.task.owner ? ` · ${name(b.task.owner)}` : ''}` : b.last?.subject}</span>
              </span>
              <span className="git-meta">
                {b.name !== data.main && <span className="num xs" title={`${b.ahead} commits ahead of ${data.main}, ${b.behind} behind`}><ArrowUp size={11} />{b.ahead} <ArrowDown size={11} />{b.behind}</span>}
                {b.last && <span className="faint xs">{timeAgo(b.last.at)}</span>}
              </span>
            </button>
            {open === b.name && (
              <div className="git-detail">
                <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
                  <span className="faint small">{b.name === data.main ? 'Latest commit on main' : `What ${b.name} changes since it left ${data.main}`}</span>
                  <span className="spacer" />
                  <button className="sm ghost" onClick={() => onBrowse(b.name)}><FileCode2 /> Browse files</button>
                </div>
                {b.name === data.main ? <CommitDetail projectId={projectId} sha={b.sha} /> : <BranchDiff projectId={projectId} base={data.main} head={b.name} />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BranchDiff({ projectId, base, head }: { projectId: string; base: string; head: string }) {
  const { data, error } = useQuery<Patch & { commits: Commit[] }>('git.diff', { projectId, base, head });
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="faint small">Loading…</p>;
  return (
    <>
      {data.commits.length > 0 && <ul className="commit-mini">{data.commits.map((c) => <li key={c.sha}><GitCommitHorizontal size={13} /><span className="mono xs faint">{c.sha.slice(0, 8)}</span><span className="small">{c.subject}</span><span className="faint xs">{c.author} · {timeAgo(c.at)}</span></li>)}</ul>}
      <DiffView patch={data} />
    </>
  );
}

function HistoryView({ projectId }: { projectId: string }) {
  const { data, error } = useQuery<{ commits: Commit[] }>('git.log', { projectId, limit: 150 }, { pollMs: 5_000 });
  const [open, setOpen] = useState<string>();
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  return (
    <div className="panel">
      <ol className="history">
        {data.commits.map((c) => (
          <li key={c.sha} className={c.parents.length > 1 ? 'merge' : ''}>
            <button className="git-row" aria-expanded={open === c.sha} onClick={() => setOpen(open === c.sha ? undefined : c.sha)}>
              <span className="graph" aria-hidden>{c.parents.length > 1 ? <GitMerge size={14} /> : <i />}</span>
              <span className="git-main">
                <span className="small strong wrap">{c.subject}</span>
                <span className="row xs faint" style={{ gap: 'var(--s-2)' }}>
                  <span className="mono">{c.sha.slice(0, 8)}</span>
                  <span>{c.author}</span>
                  <span>{timeAgo(c.at)}</span>
                  {c.refs.map((r) => <span key={r} className={`badge chip ${r === 'main' ? 'good' : ''}`}>{r}</span>)}
                </span>
              </span>
            </button>
            {open === c.sha && <div className="git-detail"><CommitDetail projectId={projectId} sha={c.sha} /></div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CommitDetail({ projectId, sha }: { projectId: string; sha: string }) {
  const { data, error } = useQuery<{ commit: Commit; body: string } & Patch>('git.show', { projectId, sha });
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="faint small">Loading…</p>;
  return (
    <>
      <p className="small"><span className="mono faint">{data.commit.sha.slice(0, 10)}</span> · {data.commit.author} · {clock(data.commit.at)}</p>
      {data.body && <pre className="commit-body">{data.body}</pre>}
      <DiffView patch={data} />
    </>
  );
}

function Worktrees({ projectId, onTerminal, onBrowse }: { projectId: string; onTerminal: (path: string) => void; onBrowse: (w: Worktree) => void }) {
  const { data, error } = useQuery<{ worktrees: Worktree[] }>('git.worktrees', { projectId }, { pollMs: 4_000 });
  const [open, setOpen] = useState<string>();
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  return (
    <div className="worktrees">
      {data.worktrees.map((w) => (
        <article key={w.path} className="panel worktree">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            {w.agent ? <Avatar name={w.agent.name} size="xs" /> : <FolderGit2 size={16} />}
            <strong className="truncate">{w.agent ? `${w.agent.name}’s worktree` : w.main ? 'The repository' : 'Worktree'}</strong>
            <span className="spacer" />
            <span className="badge chip mono">{w.branch ?? `detached ${w.head?.slice(0, 8) ?? ''}`}</span>
          </div>
          <div className="mono xs faint wrap">{w.path}</div>
          <div className="row">
            <span className={`small ${w.changes.length ? '' : 'faint'}`}>{w.changes.length ? `${w.changes.length} uncommitted change${w.changes.length === 1 ? '' : 's'}` : 'Clean'}</span>
            <span className="spacer" />
            {w.changes.length > 0 && <button className="sm ghost" onClick={() => setOpen(open === w.path ? undefined : w.path)}>{open === w.path ? 'Hide' : 'Show'} changes</button>}
            <button className="sm ghost" onClick={() => onBrowse(w)}><FileCode2 /> Files</button>
            <button className="sm" onClick={() => onTerminal(w.path)}><SquareTerminal /> Terminal</button>
            <a className="btn sm ghost" href={`vscode://file${w.path}`} title="Open in VS Code (on the hub machine)"><ExternalLink /> Editor</a>
          </div>
          {open === w.path && (
            <>
              <ul className="changes-list">{w.changes.map((c) => <li key={c.path}><span className={`st st-${c.status.replace('?', 'q')}`}>{c.status}</span><span className="mono xs wrap">{c.path}</span></li>)}</ul>
              <WorktreeDiff projectId={projectId} worktree={w.path} />
            </>
          )}
        </article>
      ))}
    </div>
  );
}

function WorktreeDiff({ projectId, worktree }: { projectId: string; worktree: string }) {
  const { data, error } = useQuery<Patch>('git.worktree_diff', { projectId, worktree }, { pollMs: 4_000 });
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  return data.files.length ? <DiffView patch={data} /> : <p className="faint small">Only new files: nothing tracked has changed.</p>;
}

function Files({ projectId, source, onSource }: { projectId: string; source: { ref?: string; worktree?: string; label: string }; onSource: (s: { ref?: string; worktree?: string; label: string }) => void }) {
  const [path, setPath] = useState('');
  const [fileOpen, setFileOpen] = useState<string>();
  const where = source.worktree ? { worktree: source.worktree } : source.ref ? { ref: source.ref } : {};
  const { data, error } = useQuery<{ entries: Array<{ name: string; path: string; kind: 'dir' | 'file'; size: number | null }> }>('git.tree', { projectId, path, ...where });
  const { data: branches } = useQuery<{ main: string; branches: Branch[] }>('git.branches', { projectId });
  const { data: wts } = useQuery<{ worktrees: Worktree[] }>('git.worktrees', { projectId });
  const crumbs = path ? path.split('/') : [];
  return (
    <div className="files">
      <div className="row files-bar">
        <label className="sr-only" htmlFor="files-source">Show files from</label>
        <select
          id="files-source"
          value={source.worktree ? `wt:${source.worktree}` : `ref:${source.ref ?? branches?.main ?? 'main'}`}
          onChange={(e) => {
            const v = e.target.value;
            setPath('');
            setFileOpen(undefined);
            if (v.startsWith('wt:')) {
              const w = wts?.worktrees.find((x) => x.path === v.slice(3));
              onSource({ worktree: v.slice(3), label: w?.agent ? `${w.agent.name}’s worktree` : 'worktree' });
            } else onSource({ ref: v.slice(4), label: v.slice(4) });
          }}
        >
          <optgroup label="Branches (committed)">{(branches?.branches ?? []).map((b) => <option key={b.name} value={`ref:${b.name}`}>{b.name}</option>)}</optgroup>
          <optgroup label="Worktrees (on disk, with uncommitted work)">{(wts?.worktrees ?? []).map((w) => <option key={w.path} value={`wt:${w.path}`}>{w.agent ? `${w.agent.name}’s worktree` : w.main ? 'the repository' : w.path}</option>)}</optgroup>
        </select>
        <nav className="crumbs" aria-label="Path">
          <button className="ghost sm" onClick={() => { setPath(''); setFileOpen(undefined); }}>{source.label}</button>
          {crumbs.map((c, i) => <span key={i}>/<button className="ghost sm" onClick={() => { setPath(crumbs.slice(0, i + 1).join('/')); setFileOpen(undefined); }}>{c}</button></span>)}
        </nav>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="files-grid">
        <ul className="panel file-list">
          {path && <li><button className="git-row" onClick={() => { setPath(crumbs.slice(0, -1).join('/')); setFileOpen(undefined); }}><Folder size={14} /> ..</button></li>}
          {(data?.entries ?? []).map((e) => (
            <li key={e.path}>
              <button className={`git-row ${fileOpen === e.path ? 'active' : ''}`} onClick={() => (e.kind === 'dir' ? (setPath(e.path), setFileOpen(undefined)) : setFileOpen(e.path))}>
                {e.kind === 'dir' ? <Folder size={14} /> : <File size={14} />}
                <span className="truncate">{e.name}</span>
                {e.size !== null && <span className="faint xs num" style={{ marginLeft: 'auto' }}>{size(e.size)}</span>}
              </button>
            </li>
          ))}
          {data && data.entries.length === 0 && <li className="faint small" style={{ padding: 'var(--s-3)' }}>Empty.</li>}
        </ul>
        <div className="file-view">{fileOpen ? <FileView projectId={projectId} path={fileOpen} where={where} /> : <p className="faint small">Pick a file to read it.</p>}</div>
      </div>
    </div>
  );
}

function FileView({ projectId, path, where }: { projectId: string; path: string; where: { ref?: string; worktree?: string } }) {
  const { data, error } = useQuery<{ text: string | null; binary: boolean; size: number; truncated: boolean }>('git.file', { projectId, path, ...where });
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  if (data.binary) return <p className="faint small">{path} is a binary file ({size(data.size)}).</p>;
  const lines = (data.text ?? '').split('\n');
  return (
    <div className="panel code-view">
      <div className="panel-head"><File /><h3 className="mono wrap">{path}</h3>{where.worktree && <a className="btn sm ghost" style={{ marginLeft: 'auto' }} href={`vscode://file${where.worktree}/${path}`}><ExternalLink /> Editor</a>}</div>
      <ol className="source">{lines.map((l, i) => <li key={i}><code>{l || ' '}</code></li>)}</ol>
      {data.truncated && <p className="faint small" style={{ padding: 'var(--s-3)' }}>Showing the first 400 kB.</p>}
    </div>
  );
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── diffs ──────────────────────────────────────────────────────────────────────────────

interface DiffFile { path: string; lines: Array<{ kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; old?: number; new?: number }> }

function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      cur.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) cur.lines.push({ kind: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
  }
  return files;
}

export function DiffView({ patch }: { patch: Patch }) {
  const files = useMemo(() => parsePatch(patch.patch), [patch.patch]);
  const stats = new Map(patch.files.map((f) => [f.path, f]));
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (files.length === 0) return <p className="faint small">No changes.</p>;
  return (
    <div className="diff">
      {files.map((f) => {
        const s = stats.get(f.path);
        const isClosed = closed.has(f.path);
        return (
          <section key={f.path} className="diff-file">
            <button className="diff-head" aria-expanded={!isClosed} onClick={() => { const next = new Set(closed); if (isClosed) next.delete(f.path); else next.add(f.path); setClosed(next); }}>
              {isClosed ? <ChevronRight /> : <ChevronDown />}
              <span className="mono small wrap">{f.path}</span>
              {s && <span className="num xs"><span className="add">+{s.added}</span> <span className="del">−{s.removed}</span></span>}
            </button>
            {!isClosed && (
              <table className="diff-lines">
                <tbody>
                  {f.lines.map((l, i) => (
                    <tr key={i} className={l.kind}>
                      <td className="ln">{l.kind === 'hunk' ? '' : (l.old ?? '')}</td>
                      <td className="ln">{l.kind === 'hunk' ? '' : (l.new ?? '')}</td>
                      <td className="code-cell"><span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      {patch.truncated && <p className="faint small">The diff is long; showing the first 400 kB.</p>}
    </div>
  );
}

