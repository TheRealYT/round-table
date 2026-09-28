# ADR-0019: S2c, the daily-driver slice, and a team that wakes only for work

- Status: proposed (2026-09-28), built on `claude/cool-wright-ii0tkj`; goes to the human with the branch
- Evidence: [`perf.md`](../perf.md), `e2e/bench-tictactoe.ts`, `rt report`

## Context

The human built a whole project with hub-run agents: a basic tic-tac-toe game. It worked, and it took more than an hour. Their list of what stops Round Table from being a daily driver:

- messages go to everyone;
- no model or effort choice per agent;
- no view of git or a terminal;
- the UI scrolls sideways;
- the conversation isn't where an IDE puts it;
- "test command" is too narrow;
- no settings, and no full-auto mode;
- it should use fewer tokens.

Much of that is S4 (budgets, human-away), S5 (Settings, Metrics, notifications) and S6 (commits in the logs) in the build plan. Building S3 first would keep the app hard to use for months.

We measured before changing anything. `project.insights` (and `rt report` on any hub database) splits each task into phases (approval, waiting to be claimed, coding, review and test, the hub's check run and merge). It also counts each agent's turns by what started them: kickoff, board step, request, verdict, hub alert, agent message, broadcast or notice. A real run of the same small game with Claude Code (a leader and two workers) showed where the waste was:

- 17 of 21 turns were started by hub notices rather than work, and 11 were acknowledgements under 5 seconds;
- the leader started as a worker, because it was made leader after it started, so its first 35-second turn proposed tasks;
- all three agents proposed overlapping plans, and each rejection woke its proposer.

## Decision

A new slice, **S2c**, sits between S2b and S3. It takes these parts forward, and S3 starts once S2c is green:

- **Wake only for work.** An idle hub-run agent is woken only by `human`, `critical` and `direct` messages, a board step, or a hub notice. `normal` and `digest` messages ride along with its next turn. A burst of agent messages within the coalescing window (2 s) becomes one turn.
- **Messages reach who needs them:**
  - A worker's message to everyone is `normal` at most, or refused when the project says so.
  - Proposal commits and rejections are FYIs.
  - A plan approval tells only the workers without a task.
  - A merge tells the author, the leader, and whoever waited on the task.
  - "Affected" audiences (not resolved until S3) get a `normal` FYI instead of a wake-up.
- **The leader plans:**
  - With a leader, the leader proposes the whole plan and commits it in one `board_commit {ticketIds}`.
  - Tasks can depend on each other by ticket id.
  - It is told to keep tasks on different files and to avoid dependencies it doesn't need.
  - Workers wait for the plan.
  - `agent.spawn {leader}` starts an agent as the leader, so its first turn already plans.
- **Cheaper turns:**
  - Each agent's model and effort (`--effort`) can be set by provider, by role (settings), per start, or later per agent (it restarts when idle and resumes its conversation).
  - Claude Code agents see only their role's tools.
  - Reviews go to the least busy peer.
  - The hub keeps one merge worktree per repository, so installed dependencies survive between check runs.
- **Daily-driver features:** settings with per-project overrides (ADR-0020), insights, read-only git and the terminal (ADR-0021), provider logos, and the conversation as a side panel.

## Consequences

- The same run afterwards:
  - turns went from 21 to 14, messages from 27 to 13 (deliveries from 39 to 16), and broadcasts from 4 to 0;
  - cost went from $1.71 to $1.09, and tokens from 2.53M to 1.31M;
  - wall time stayed about the same (2.5 min), because the leader made one task depend on the other; the planning brief now discourages that.
- A 3-minute benchmark doesn't explain an hour. `rt report` on the human's own database will show where their hour went: approval waits, agy's per-turn start, conflicts, or idle agents.
- Normal messages to an idle agent now wait for its next real turn. An agent that must hear something now has to be named (direct), or the leader sends it as critical.
