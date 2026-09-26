# ADR-0009: The hub runs tests itself as the merge gate

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The done rule needs a "passing test_result". A result posted by an agent is only a claim, and tests that pass on a branch can still fail after merging with a newer main (a spec edge case).

## Decision

- Before moving `main`, the hub runs `rules.test_command` (from the `rules` section, set by the human) through the `TestRunner` port, in a scratch worktree holding the **merge result** of main + head sha, with a timeout from settings.
- The result is recorded in `quality` with its output tail and duration. A failure sends the CR back to the author with the log and alerts the tester.
- The tester agent's `respond(..., {status: 'pass', headSha})` is still required. It shows that tests were written against the acceptance criteria. The hub run is the gate.

## Consequences

- "Tests pass on branch, fail on main" is caught before the merge, not after.
- Merges take as long as the test suite. The sample repo's suite is expected to run in seconds, and long suites are a later concern (queued merges).
