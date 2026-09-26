import type { EventPayloads, EventRow, Principal, Sha } from '@round-table/protocol';
import type { Model } from '@round-table/core';
import type { CommandBus } from './bus.ts';
import type { GitHost, TestRunner } from './git.ts';

const HUB: Principal = { kind: 'hub', component: 'merge-reactor' };
const MAX_CAS_RETRIES = 3;

/**
 * The merge gate's IO (ADR-0008, ADR-0009): on `merge.requested`, merge main + head in a scratch
 * worktree, run the project's test command there, and move main by compare-and-swap. Runs outside
 * the bus and reports with `merge.result`. Merges on one repository run one at a time.
 */
export class MergeReactor {
  private readonly model: Model;
  private readonly bus: CommandBus;
  private readonly git: GitHost;
  private readonly tests: TestRunner;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly log: (message: string) => void;

  constructor(options: { model: Model; bus: CommandBus; git: GitHost; tests: TestRunner; log?: (m: string) => void }) {
    this.model = options.model;
    this.bus = options.bus;
    this.git = options.git;
    this.tests = options.tests;
    this.log = options.log ?? (() => {});
  }

  onCommit(rows: EventRow[]): void {
    for (const row of rows) if (row.type === 'merge.requested') this.enqueue(row.payload as EventPayloads['merge.requested']);
  }

  /** After a restart: merges that were requested but never reported. */
  resumePending(): void {
    for (const project of Object.values(this.model.projects)) {
      for (const cr of Object.values(project.changeRequests)) {
        const head = cr.mergeRequestedFor;
        if (!head || cr.status === 'merged' || cr.hubRuns.some((r) => r.headSha === head)) continue;
        const rules = Object.values(project.entries).find((e) => e.section === 'rules')?.data as { testCommand?: string; testTimeoutSec?: number } | undefined;
        if (!rules?.testCommand) continue;
        this.enqueue({ changeRequestId: cr.changeRequestId, headSha: head, repoId: cr.repoId, testCommand: rules.testCommand, testTimeoutSec: rules.testTimeoutSec ?? 600 });
      }
    }
  }

  /** Resolves when every queued merge has finished (tests use it). */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private enqueue(request: EventPayloads['merge.requested']): void {
    const previous = this.queues.get(request.repoId) ?? Promise.resolve();
    const next = previous.then(() => this.run(request)).catch((error: unknown) => {
      this.log(`merge ${request.changeRequestId} crashed: ${error instanceof Error ? error.message : String(error)}`);
      this.report(request, { outcome: 'error', message: `the hub could not run the merge: ${error instanceof Error ? error.message : String(error)}` });
    });
    this.queues.set(request.repoId, next);
  }

  private async run(request: EventPayloads['merge.requested']): Promise<void> {
    const repo = this.model.repos[request.repoId];
    const cr = Object.values(this.model.projects).map((p) => p.changeRequests[request.changeRequestId]).find(Boolean);
    if (!repo || !cr) return this.report(request, { outcome: 'error', message: 'repository or change request missing' });
    for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
      const merge = await this.git.mergeInScratch(repo.path, repo.mainBranch, request.headSha, `Merge ${cr.branch} (${cr.changeRequestId}, task ${cr.taskId})`);
      if (!merge.ok) {
        if (merge.reason === 'conflict') return this.report(request, { outcome: 'conflict', files: merge.files, baseSha: merge.baseSha });
        return this.report(request, { outcome: 'error', message: `missing ${merge.ref}` });
      }
      try {
        const run = await this.tests.run({ cwd: merge.scratchPath, command: request.testCommand, timeoutMs: request.testTimeoutSec * 1000 });
        if (run.status !== 'pass') {
          return this.report(request, { outcome: run.status === 'error' ? 'error' : 'tests_failed', run: { status: run.status, durationMs: run.durationMs, outputTail: run.outputTail } });
        }
        if (await this.git.updateBranchCas(repo.path, repo.mainBranch, merge.mergeSha, merge.baseSha)) {
          return this.report(request, { outcome: 'merged', mergeSha: merge.mergeSha, baseSha: merge.baseSha, run: { status: 'pass', durationMs: run.durationMs, outputTail: run.outputTail } });
        }
        this.log(`main moved during the merge of ${cr.changeRequestId}; retrying (${attempt}/${MAX_CAS_RETRIES})`);
      } finally {
        await this.git.removeScratch(repo.path, merge.scratchPath);
      }
    }
    return this.report(request, { outcome: 'error', message: 'main kept moving; merge abandoned after retries' });
  }

  private report(
    request: EventPayloads['merge.requested'],
    result: { outcome: 'merged' | 'tests_failed' | 'conflict' | 'error'; mergeSha?: Sha; baseSha?: Sha; run?: { status: 'pass' | 'fail' | 'timeout' | 'error'; durationMs: number; outputTail: string }; files?: string[]; message?: string },
  ): void {
    const outcome = this.bus.dispatch('merge.result', { changeRequestId: request.changeRequestId, headSha: request.headSha, ...result }, HUB);
    if (!outcome.ok) this.log(`merge.result for ${request.changeRequestId} rejected: ${outcome.rejection.message}`);
  }
}
