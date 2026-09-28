import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Read-only git for the human (S2c, the Code tab): branches, history, commits and diffs, each
 * agent's worktree, and files at a ref or in a worktree. Nothing here writes to the repository.
 * Inputs are checked before they reach git so a ref or path can't become an option.
 */

const REF = /^(?!-)[\w./@^~-]{1,200}$/;
const SHA = /^[0-9a-f]{4,64}$/i;
const PATCH_CAP = 400_000;
const FILE_CAP = 400_000;

function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString().trim().split('\n')[0] || error.message));
      else resolvePromise(stdout.toString());
    });
  });
}

export function checkRef(ref: string): string {
  if (!REF.test(ref) || ref.includes('..')) throw new Error(`not a ref: ${ref}`);
  return ref;
}

function checkPath(path: string): string {
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').some((p) => p === '..')) throw new Error('paths stay inside the repository');
  return clean;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  at: number;
  subject: string;
  refs: string[];
}

const FORMAT = '%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e';

function parseCommits(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, author, at, subject, refs] = r.split('\x1f');
      return {
        sha: sha!,
        parents: parents ? parents.split(' ') : [],
        author: author ?? '',
        at: Number(at) * 1000,
        subject: subject ?? '',
        refs: refs ? refs.split(', ').map((x) => x.replace(/^HEAD -> /, '')).filter((x) => x && x !== 'HEAD') : [],
      };
    });
}

export interface BranchInfo {
  name: string;
  sha: string;
  ahead: number;
  behind: number;
  last: Commit | null;
}

export async function branches(repo: string, main: string): Promise<BranchInfo[]> {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(objectname)', 'refs/heads']);
  const rows = out.split('\n').filter(Boolean).map((l) => l.split('\x1f') as [string, string]);
  return Promise.all(
    rows.map(async ([name, sha]) => {
      const [counts, last] = await Promise.all([
        name === main ? Promise.resolve('0\t0') : git(repo, ['rev-list', '--left-right', '--count', `${main}...${sha}`]).catch(() => '0\t0'),
        git(repo, ['log', '-1', `--format=${FORMAT}`, sha]),
      ]);
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      return { name, sha, ahead: ahead ?? 0, behind: behind ?? 0, last: parseCommits(last)[0] ?? null };
    }),
  );
}

/** Newest commits across all local branches (or one ref), with parents for drawing the graph. */
export async function log(repo: string, options: { ref?: string; limit: number }): Promise<Commit[]> {
  const scope = options.ref ? [checkRef(options.ref)] : ['--branches'];
  return parseCommits(await git(repo, ['log', '--date-order', `--format=${FORMAT}`, '-n', String(options.limit), ...scope, '--']));
}

export interface FileStat {
  path: string;
  added: number;
  removed: number;
}

export interface Patch {
  files: FileStat[];
  patch: string;
  truncated: boolean;
}

async function patchOf(repo: string, args: string[]): Promise<Patch> {
  const [numstat, patch] = await Promise.all([git(repo, [...args, '--numstat', '--format=']), git(repo, [...args, '--patch', '--format=', '--no-color'])]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split('\t');
      return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) };
    });
  return { files, patch: patch.slice(0, PATCH_CAP), truncated: patch.length > PATCH_CAP };
}

export async function show(repo: string, sha: string): Promise<{ commit: Commit; body: string } & Patch> {
  if (!SHA.test(sha)) throw new Error(`not a commit: ${sha}`);
  const [meta, body] = await Promise.all([git(repo, ['log', '-1', `--format=${FORMAT}`, sha]), git(repo, ['log', '-1', '--format=%b', sha])]);
  const commit = parseCommits(meta)[0];
  if (!commit) throw new Error(`no commit ${sha}`);
  // First parent: a merge shows what it brought into main.
  const patch = await patchOf(repo, commit.parents.length > 0 ? ['diff', commit.parents[0]!, sha] : ['show', '--root', sha]);
  return { commit, body: body.trim(), ...patch };
}

/** What `head` changes relative to where it left `base` (base...head), as a change request shows it. */
export async function diff(repo: string, base: string, head: string): Promise<Patch & { commits: Commit[] }> {
  checkRef(base);
  checkRef(head);
  const [patch, commits] = await Promise.all([patchOf(repo, ['diff', `${base}...${head}`]), git(repo, ['log', `--format=${FORMAT}`, '-n', '100', `${base}..${head}`, '--'])]);
  return { ...patch, commits: parseCommits(commits) };
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  changes: Array<{ status: string; path: string }>;
  main: boolean;
}

export async function worktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const list: WorktreeInfo[] = [];
  for (const block of out.split('\n\n').filter((b) => b.trim())) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9) ?? '';
    if (!path || !existsSync(path) || /rt-merge-/.test(path)) continue; // the hub's own merge worktree
    list.push({
      path,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? null,
      branch: lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18) ?? null,
      detached: lines.includes('detached'),
      changes: [],
      main: list.length === 0,
    });
  }
  await Promise.all(
    list.map(async (w) => {
      const status = await git(w.path, ['status', '--porcelain=v1', '--untracked-files=normal']).catch(() => '');
      w.changes = status.split('\n').filter(Boolean).slice(0, 200).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
    }),
  );
  return list;
}

/** Uncommitted changes in a worktree, as a patch (tracked files) plus the list of new files. */
export async function worktreeDiff(worktree: string): Promise<Patch> {
  return patchOf(worktree, ['diff', 'HEAD']);
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number | null;
}

export async function tree(repo: string, ref: string, path: string): Promise<TreeEntry[]> {
  checkRef(ref);
  const dir = checkPath(path);
  const out = await git(repo, ['ls-tree', '-l', `${ref}:${dir}`]).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [meta, name] = l.split('\t') as [string, string];
      const [, type, , size] = meta.split(/\s+/);
      return { name, path: dir ? `${dir}/${name}` : name, kind: type === 'tree' ? ('dir' as const) : ('file' as const), size: size && size !== '-' ? Number(size) : null };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

export interface FileContent {
  path: string;
  text: string | null;
  binary: boolean;
  size: number;
  truncated: boolean;
}

function asText(path: string, buf: Buffer): FileContent {
  const binary = buf.subarray(0, 8000).includes(0);
  return { path, text: binary ? null : buf.subarray(0, FILE_CAP).toString('utf8'), binary, size: buf.length, truncated: buf.length > FILE_CAP };
}

export async function file(repo: string, ref: string, path: string): Promise<FileContent> {
  checkRef(ref);
  const p = checkPath(path);
  const buf = await new Promise<Buffer>((resolvePromise, reject) => {
    execFile('git', ['-C', repo, 'show', `${ref}:${p}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(new Error(`no file ${p} at ${ref}`)) : resolvePromise(stdout)));
  });
  return asText(p, buf);
}

/** A file as it is on disk in a worktree (uncommitted work included). */
export function worktreeFile(worktree: string, path: string): FileContent {
  const p = checkPath(path);
  const full = resolve(worktree, p);
  const rel = relative(worktree, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('paths stay inside the worktree');
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`no file ${p}`);
  return asText(p, readFileSync(full));
}

/** Entries of a worktree directory on disk, without .git. */
export async function worktreeTree(worktree: string, path: string): Promise<TreeEntry[]> {
  const dir = checkPath(path);
  const out = await git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '--', dir || '.']);
  const seen = new Map<string, TreeEntry>();
  for (const f of out.split('\n').filter(Boolean)) {
    const rest = dir ? f.slice(dir.length + 1) : f;
    if (dir && !f.startsWith(`${dir}/`)) continue;
    const [head, ...more] = rest.split('/');
    if (!head) continue;
    const entryPath = dir ? `${dir}/${head}` : head;
    if (!seen.has(head)) seen.set(head, { name: head, path: entryPath, kind: more.length ? 'dir' : 'file', size: more.length ? null : safeSize(join(worktree, entryPath)) });
  }
  return [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

function safeSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
