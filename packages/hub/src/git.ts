import type { ChangeRequestId, RepoId, Sha, TaskId, AgentId } from '@round-table/protocol';

/** A change request: the MVP's stand-in for a PR (ADR-0008). */
export interface ChangeRequest {
  id: ChangeRequestId;
  taskId: TaskId;
  author: AgentId;
  repoId: RepoId;
  branch: string;
  base: string;
  headSha: Sha;
}

export type MergeAttempt =
  | { ok: true; mergeSha: Sha; baseSha: Sha; scratchPath: string }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'missing_ref'; ref: string };

export type RefChange = { repoId: RepoId; ref: string; from: Sha | null; to: Sha | null; worktree: string | null };

/**
 * Git port. The MVP adapter is LocalGitHost (worktrees in the registered repo, scratch area for
 * merges). A GitHub adapter can come later behind the same interface.
 */
export interface GitHost {
  /** One worktree per agent slot, created by `rt agent install`. */
  ensureWorktree(repoId: RepoId, slot: string): Promise<{ path: string }>;
  resolve(repoId: RepoId, ref: string): Promise<Sha | null>;
  /** Merges `head` into the current `base` in a scratch worktree; nothing is published yet. */
  mergeInScratch(repoId: RepoId, base: string, head: Sha): Promise<MergeAttempt>;
  /** Compare-and-swap a ref: moves `ref` to `to` only if it still points at `expected`. */
  updateRefCas(repoId: RepoId, ref: string, to: Sha, expected: Sha): Promise<boolean>;
  removeScratch(path: string): Promise<void>;
  /** The git watcher: calls back on branch, commit and push activity, including agents' worktrees. */
  watch(repoId: RepoId, onChange: (change: RefChange) => void): () => void;
}

export interface TestRunResult {
  status: 'pass' | 'fail' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined output, redacted before it is logged. */
  outputTail: string;
}

/** Runs the project's `rules.test_command` in a directory, for the hub's merge gate (ADR-0009). */
export interface TestRunner {
  run(options: { cwd: string; command: string; timeoutMs: number; env?: Record<string, string> }): Promise<TestRunResult>;
}
