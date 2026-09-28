# Performance: where a team's time and tokens go

Measured with `e2e/bench-tictactoe.ts`: real Claude Code agents (a leader and two workers) build a browser tic-tac-toe game in an empty repository whose check is `npm test` (node's own test runner), and the script approves the plan at once. `rt report` prints the same table for any hub database, including your own projects.

## 2026-09-28, Claude Code 2.1.283

| | Before S2c | After the S2c speed changes |
|---|---|---|
| Outcome | 2 of 2 tasks done | 2 of 2 tasks done |
| Wall time (first turn to last merge) | 2 min 32 s | 2 min 41 s |
| Turns | 21 | 14 |
| Turns under 5 s | 11 | 8 |
| Cost | $1.71 | $1.09 |
| Tokens | 2.53M | 1.31M |
| Messages / deliveries | 27 / 39 | 13 / 16 |
| Messages to everyone | 4 | 0 |
| Leader | 5 turns, $0.40 | 4 turns, $0.17 |

What changed between the two runs:
- The leader starts as the leader and plans alone, committing the plan in one call.
- Only direct, critical and human messages wake an idle agent.
- Worker broadcasts are FYIs.
- Hub alerts go only to whoever needs them.

Wall time didn't move because the leader made the UI task depend on the logic task, so they ran one after the other ("Tasks ran one at a time" in the findings). The planning brief now tells the leader to share interfaces in the criteria instead of adding dependencies.

## Reading a report

- **Approval**: the time a plan waited for your click. Full auto (Settings → Autonomy) removes it.
- **To-claim**: time from a task being ready until a worker claimed it. It's high when workers are busy or a dependency isn't merged.
- **Coding**: from the claim to the change request.
- **Verify**: from the change request to the merge request, i.e. the review and test by another agent.
- **Hub**: the hub's check run on main + the change, and the merge. Use `npm install && npm test` rather than `npm ci`, so the kept merge worktree reuses installed packages.
- **Turns started by** hub alerts, notices or broadcasts, and **turns under 5 s**: acknowledgements that cost tokens without moving work.
