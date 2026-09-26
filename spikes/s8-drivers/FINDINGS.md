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
