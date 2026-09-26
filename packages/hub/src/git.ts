import type { Sha } from '@round-table/protocol';

export type MergeAttempt =
  | { ok: true; mergeSha: Sha; baseSha: Sha; scratchPath: string }
  | { ok: false; reason: 'conflict'; baseSha: Sha; files: string[] }
  | { ok: false; reason: 'missing_ref'; ref: string };

/**
 * Git port (ADR-0008). The MVP adapter is LocalGitHost: the registered repository on disk, agent
 * worktrees, and scratch worktrees for merges. A GitHub adapter can come later behind the same port.
 */
export interface GitHost {
  /** The repository's real top-level path, or undefined if `path` is not a git repository. */
  topLevel(path: string): Promise<string | undefined>;
  /** Commit sha of a local branch, or null if it does not exist. */
  resolveBranch(repoPath: string, branch: string): Promise<Sha | null>;
  /** Branches checked out in any worktree (moving one of them under a checkout leaves that checkout stale). */
  checkedOutBranches(repoPath: string): Promise<string[]>;
  /** Merges `headSha` into the current `baseBranch` in a new scratch worktree; nothing is published. */
  mergeInScratch(repoPath: string, baseBranch: string, headSha: Sha, message: string): Promise<MergeAttempt>;
  /** Compare-and-swap: moves `refs/heads/<branch>` to `to` only if it still points at `expected`. */
  updateBranchCas(repoPath: string, branch: string, to: Sha, expected: Sha): Promise<boolean>;
  removeScratch(repoPath: string, scratchPath: string): Promise<void>;
}

export interface TestRunResult {
  status: 'pass' | 'fail' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined output. */
  outputTail: string;
}

/** Runs the project's `rules.testCommand` in a directory, for the hub's merge gate (ADR-0009). */
export interface TestRunner {
  run(options: { cwd: string; command: string; timeoutMs: number; env?: Record<string, string> }): Promise<TestRunResult>;
}
