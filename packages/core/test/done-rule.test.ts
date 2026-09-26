import { describe, expect, it } from 'vitest';
import type { AgentId, Sha } from '@round-table/protocol';
import { evaluateDoneRule, readyForHubRun, type ChangeRequestFacts } from '../src/index.ts';

const author = 'agt_A' as AgentId;
const reviewer = 'agt_R' as AgentId;
const tester = 'agt_T' as AgentId;
const sha1 = '1'.repeat(40) as Sha;
const sha2 = '2'.repeat(40) as Sha;

const complete: ChangeRequestFacts = {
  author,
  headSha: sha1,
  reviews: [{ by: reviewer, verdict: 'approved', headSha: sha1 }],
  testResults: [{ by: tester, status: 'pass', headSha: sha1 }],
  hubRuns: [{ headSha: sha1, status: 'pass' }],
};

describe('done rule', () => {
  it('is met with a non-author approval, a non-author pass and a hub run at the same head', () => {
    expect(evaluateDoneRule(complete)).toEqual({ met: true });
  });

  it('ignores the author approving or testing their own work', () => {
    const selfServed = { ...complete, reviews: [{ by: author, verdict: 'approved' as const, headSha: sha1 }], testResults: [{ by: author, status: 'pass' as const, headSha: sha1 }] };
    expect(evaluateDoneRule(selfServed)).toEqual({ met: false, missing: ['review_approval', 'tester_pass'] });
  });

  it('drops everything given for an older head after a new push', () => {
    expect(evaluateDoneRule({ ...complete, headSha: sha2 })).toEqual({
      met: false,
      missing: ['review_approval', 'tester_pass', 'hub_test_run'],
    });
  });

  it('is blocked by an outstanding changes_needed from any reviewer', () => {
    const other = 'agt_Q' as AgentId;
    const mixed = { ...complete, reviews: [...complete.reviews, { by: other, verdict: 'changes_needed' as const, headSha: sha1 }] };
    expect(evaluateDoneRule(mixed)).toEqual({ met: false, missing: ['review_approval'] });
  });

  it('uses the latest result per head', () => {
    const flipped = { ...complete, testResults: [...complete.testResults, { by: tester, status: 'fail' as const, headSha: sha1 }] };
    expect(evaluateDoneRule(flipped)).toEqual({ met: false, missing: ['tester_pass'] });
  });

  it('starts the hub run once only the hub run is missing', () => {
    expect(readyForHubRun({ ...complete, hubRuns: [] })).toBe(true);
    expect(readyForHubRun({ ...complete, hubRuns: [], testResults: [] })).toBe(false);
  });
});
