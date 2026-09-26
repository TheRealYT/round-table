# ADR-0008: LocalGitHost, change requests and hub-performed merges

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The MVP runs locally on a sample repo, so there is no GitHub and no PR object. The spec still speaks of opening PRs and merging them. Tying approval to a PR rather than to a commit also lets new code merge on an old approval.

## Decision

- A `GitHost` port. The MVP adapter is **LocalGitHost**: the registered repo path, one worktree per agent slot (`git worktree add`), and a hub-owned scratch area for merges and test runs.
- A **ChangeRequest** is `{id, taskId, branch, base, headSha, author}`. It is opened with `board_propose('artifacts', 'open', {kind: 'change_request', taskId, branch})`. The hub reads `headSha` from git, and the git watcher updates it on every push.
- Review and test `respond` results must carry `headSha`. They count only while it equals the CR's current head.
- **The hub merges**: once the done rule holds, it merges main + head in a scratch worktree, runs the hub test ([ADR-0009](0009-hub-runs-tests.md)), then moves `main` with `git update-ref` compare-and-swap. A conflict sends the CR back to the author as `rebase_needed`.
- A GitHub adapter comes later behind the same port (open PR, mirror state, merge through the API).

## Consequences

- Agents never push to main themselves. The rules forbid it, and the hook adapter can deny `git push`/`git merge` on main.
- Merges are serialized through the bus, which rules out merge races between agents.
