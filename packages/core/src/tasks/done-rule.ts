import type { AgentId, Sha } from '@round-table/protocol';

/**
 * The done rule (ADR-0008, ADR-0009). A task is done only when all of these name the change
 * request's *current* head sha:
 *   1. a review approval from an agent other than the author,
 *   2. a passing test result from an agent other than the author,
 *   3. a passing hub test run on the merge result of main + head.
 * A later push changes headSha, so older approvals and results stop counting.
 */
export interface ChangeRequestFacts {
  author: AgentId;
  headSha: Sha;
  reviews: ReadonlyArray<{ by: AgentId; verdict: 'approved' | 'changes_needed'; headSha: Sha }>;
  testResults: ReadonlyArray<{ by: AgentId; status: 'pass' | 'fail'; headSha: Sha }>;
  hubRuns: ReadonlyArray<{ headSha: Sha; status: 'pass' | 'fail' | 'timeout' | 'error' | 'conflict' }>;
}

export type DoneRuleVerdict =
  | { met: true }
  | { met: false; missing: Array<'review_approval' | 'tester_pass' | 'hub_test_run'> };

function latestFor<T extends { headSha: Sha }>(items: ReadonlyArray<T>, head: Sha, pick: (t: T) => boolean): T | undefined {
  const current = items.filter((i) => i.headSha === head && pick(i));
  return current[current.length - 1];
}

export function evaluateDoneRule(cr: ChangeRequestFacts): DoneRuleVerdict {
  const missing: Array<'review_approval' | 'tester_pass' | 'hub_test_run'> = [];

  // The latest review by each non-author reviewer at this head must not be changes_needed,
  // and at least one must be an approval.
  const reviewers = new Map<AgentId, 'approved' | 'changes_needed'>();
  for (const r of cr.reviews) if (r.headSha === cr.headSha && r.by !== cr.author) reviewers.set(r.by, r.verdict);
  const verdicts = [...reviewers.values()];
  if (!verdicts.includes('approved') || verdicts.includes('changes_needed')) missing.push('review_approval');

  const test = latestFor(cr.testResults, cr.headSha, (t) => t.by !== cr.author);
  if (test?.status !== 'pass') missing.push('tester_pass');

  const run = latestFor(cr.hubRuns, cr.headSha, () => true);
  if (run?.status !== 'pass') missing.push('hub_test_run');

  return missing.length === 0 ? { met: true } : { met: false, missing };
}

/** Reviews and tester result are in for the current head: the hub may start its merge test run. */
export function readyForHubRun(cr: ChangeRequestFacts): boolean {
  const verdict = evaluateDoneRule(cr);
  return verdict.met || (verdict.missing.length === 1 && verdict.missing[0] === 'hub_test_run');
}
