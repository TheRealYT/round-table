import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sha } from '@round-table/protocol';
import type { GitHost, MergeAttempt, TestRunner, TestRunResult } from './git.ts';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Hub commits carry this identity; they are merges the hub made, not work of any agent. */
const HUB_IDENTITY = ['-c', 'user.name=Round Table hub', '-c', 'user.email=hub@round-table.invalid', '-c', 'commit.gpgsign=false'];

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** LocalGitHost (ADR-0008): plain git on the registered repository. Scratch worktrees live under the OS temp dir. */
export class LocalGitHost implements GitHost {
  private readonly scratchRoot: string;

  constructor(options: { scratchRoot?: string } = {}) {
    this.scratchRoot = options.scratchRoot ?? tmpdir();
  }

  async topLevel(path: string): Promise<string | undefined> {
    const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.code !== 0) return undefined;
    // The common dir identifies the repository across all its worktrees.
    const dir = common.stdout.trim();
    return dir.endsWith('/.git') ? dir.slice(0, -'/.git'.length) : dir;
  }

  async resolveBranch(repoPath: string, branch: string): Promise<Sha | null> {
    const out = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return out.code === 0 ? (out.stdout.trim() as Sha) : null;
  }

  async checkedOutBranches(repoPath: string): Promise<string[]> {
    const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
    return out.stdout
      .split('\n')
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length));
  }

  async mergeInScratch(repoPath: string, baseBranch: string, headSha: Sha, message: string): Promise<MergeAttempt> {
    const baseSha = await this.resolveBranch(repoPath, baseBranch);
    if (!baseSha) return { ok: false, reason: 'missing_ref', ref: baseBranch };
    const scratchPath = await mkdtemp(join(this.scratchRoot, 'rt-merge-'));
    await rm(scratchPath, { recursive: true, force: true });
    const added = await git(repoPath, ['worktree', 'add', '--detach', scratchPath, baseSha]);
    if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
    const merged = await git(scratchPath, [...HUB_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', message, headSha]);
    if (merged.code !== 0) {
      const conflicts = await git(scratchPath, ['diff', '--name-only', '--diff-filter=U']);
      await this.removeScratch(repoPath, scratchPath);
      return { ok: false, reason: 'conflict', baseSha, files: conflicts.stdout.split('\n').filter(Boolean) };
    }
    const head = await git(scratchPath, ['rev-parse', 'HEAD']);
    return { ok: true, mergeSha: head.stdout.trim() as Sha, baseSha, scratchPath };
  }

  async updateBranchCas(repoPath: string, branch: string, to: Sha, expected: Sha): Promise<boolean> {
    const out = await git(repoPath, ['update-ref', '-m', 'round-table: merge', `refs/heads/${branch}`, to, expected]);
    return out.code === 0;
  }

  async removeScratch(repoPath: string, scratchPath: string): Promise<void> {
    await git(repoPath, ['worktree', 'remove', '--force', scratchPath]);
    await rm(scratchPath, { recursive: true, force: true });
    await git(repoPath, ['worktree', 'prune']);
  }
}

const TAIL_CHARS = 4_000;

/** Runs a shell command with a timeout, killing its whole process group on timeout. */
export class ShellTestRunner implements TestRunner {
  run(options: { cwd: string; command: string; timeoutMs: number; env?: Record<string, string> }): Promise<TestRunResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const child = spawn('sh', ['-c', options.command], {
        cwd: options.cwd,
        env: { ...process.env, CI: '1', ...options.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-TAIL_CHARS * 2);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, options.timeoutMs);
      const finish = (status: TestRunResult['status'], exitCode: number | null) => {
        clearTimeout(timer);
        resolve({ status, exitCode, durationMs: Date.now() - started, outputTail: output.slice(-TAIL_CHARS) });
      };
      child.on('error', (error) => {
        output += `\n${error.message}`;
        finish('error', null);
      });
      child.on('close', (code) => finish(timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail', code));
    });
  }
}
