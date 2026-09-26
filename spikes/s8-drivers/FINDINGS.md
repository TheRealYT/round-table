# S8 findings: driving agents headless (2026-09-26)

Question: can Round Table run the agents itself (spawn, wake on a message, stop), instead of hoping
an IDE chat keeps calling `wait`? Checked against Claude Code 2.1.283, Node 24.21, in a sample git
repo with a stand-in board MCP server (`board.mjs`). Reproduce: `node claude-spike.mjs`.

| # | Question | Result |
|---|---|---|
| 1 | Resume the same session per wake-up? | **Yes.** `claude -p --session-id <uuid>` then `--resume <uuid>` per message: 4 wake-ups, same session id, the codeword from wake-up 1 was recalled in 2–4. 8–11 s per wake-up for a small task (edit, commit, report). |
| 2 | Structured output? | **Yes.** `--output-format stream-json --verbose` gives one JSON event per line: `system:init` (session id, tools incl. MCP), `assistant` (text and tool_use), `user` (tool results), `result` (success/error, turns, cost, token usage, permission denials). Enough for status, activity feed and cost without self-reporting. |
| 3 | No approval prompts, work inside the folder? | **Yes**, with `--permission-mode bypassPermissions`: edits, `git commit` and MCP calls ran with 0 permission denials. **As root it is refused** unless `IS_SANDBOX=1` is set. Keeping the agent inside its folder is the sandbox's job (container/VM), not the flag's. |
| 4 | One long-lived process, messages pushed as they arrive? | **Yes.** `--input-format stream-json`: write `{"type":"user","message":{…}}` lines to stdin; each gets a `result`. The process stayed alive through 20 s idle and kept context (codeword recalled). First reply 42 s (startup), later ones seconds. Closing stdin exits cleanly (code 0). |
| 5 | Interrupt mid-turn and carry on? | **Yes.** A `control_request` `{subtype:"interrupt"}` during `sleep 90` was acknowledged and ended the turn in 11 ms (`result: error_during_execution`); the next message ran normally with context intact. |
| 6 | MCP tools in headless mode? | **Yes.** `--mcp-config <file> --strict-mcp-config` loads only our server; the model called `mcp__board__report` every turn. The hub's tools work unchanged. |
| 7 | Cost | `total_cost_usd` is cumulative per session; about $0.03 per small wake-up here, mostly cached context (~120k tokens read from cache, inflated by this environment's extra instructions). On a subscription login these are usage limits, not charges. |

Also: a nested `claude` inherits the parent Claude Code session's environment (`CLAUDE_CODE_SESSION_ID` and others) and reports the parent's session id. The driver must start agents with those variables removed.

## Consequences

- The **Claude Code driver** is feasible either way. Preferred: one long-lived stream-json process per agent (fast wake-ups, interrupt, clean stop); fall back to `--resume` per wake-up after a crash or hub restart, since the session id persists.
- `wait` long-polling, timeouts, "type continue", attention guesses, pairing codes and chat tokens are not needed for driven agents: the hub starts them, so it issues their identity itself.
- Status is exact: running (turn in progress), idle (turn ended, waiting for a message), stopped/crashed (process exit).
- Other CLIs (Codex, Gemini CLI, Cursor, opencode) need the same six checks before their drivers are written.

## Checking another CLI

```sh
node spikes/s8-drivers/check.mjs <claude-code|codex|antigravity|cursor|opencode> [--bin <path>]
```

Run it where the CLI is installed and logged in. It needs only Node and git: the stand-in hub (`board-server.mjs`) is a dependency-free MCP server with a `report` tool and a slow `fetch_plan` tool. It runs four headless turns in a fresh sample repo and checks the six questions above: headless JSON output, no approval prompts (a real commit), MCP tools (calls reach the stand-in hub), resume (a codeword from turn 1), interrupt (SIGINT while waiting on the slow tool, then the next turn continues), and cost or token fields.

Each CLI's recipe is in `check.mjs`. Only Claude Code's is verified: on 2026-09-26 it passed 6 of 6, stopping 0.3 s after SIGINT. The others come from each CLI's docs. Flags the CLI's `--help` doesn't list are left out, and the run says so. While a turn runs, the check prints the exact command, each tool call, the model's text, stderr, and a heartbeat every 10 s when the CLI is quiet. After 30 s of quiet it says what that usually means: a login, a trust question or an approval prompt the CLI can't show headless. The raw output also streams to `turnN.stdout.jsonl` (`tail -f`). Ctrl+C stops the run and still writes the report, including the last thing the CLI printed. Every run writes `cli-check-<cli>-<time>/` and a `.tar.gz` of it with the exact commands, raw output, `--help` and a `report.md`. That is what a driver is built from, whether the checks pass or fail.

The interrupt check uses a slow tool call and not a shell `sleep`, because Claude Code ran `sleep 90` in the background and ended its turn at once.
