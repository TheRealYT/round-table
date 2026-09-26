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

### Antigravity CLI: first run (agy 1.2.11, 2026-09-26)

- `agy -p … --output-format stream-json --dangerously-skip-permissions` starts headless. Its first event is `{"event":"init","conversation_id":…,"init":{…,"permission_mode":"always-proceed"}}`, so the approval flag works. It has its own tool set, including `run_command`, `write_to_file` and `call_mcp_tool`.
- Resume is `--conversation <id>` (or `--continue`), not `--resume`. `--input-format stream-json` exists, so a long-lived process fed messages on stdin may work as it does for Claude Code.
- MCP servers are added with `agy mcp add`, not project config files. The check now registers the stand-in hub for the run and removes it at the end.
- The run was stopped after 16 s, so checks 1–6 are still open. The check's summaries only knew events keyed `type`, so agy's `event`-keyed output showed nothing on screen. Fixed: unknown event kinds are shown the first time they appear.

### Antigravity CLI: second run (agy 1.2.11, 2026-09-26): 5 of 6 pass, interrupt still open

| Check | Result |
|---|---|
| 1 headless | pass: `agy -p … --output-format stream-json --dangerously-skip-permissions`, exit 0 in 33 s (about 14 s of it is startup before `init`) |
| 2 no-prompts | pass: `write_to_file`, then `git commit` through `run_command`, with no approval asked |
| 3 mcp | pass: the stand-in hub registered with `agy mcp add`; agy reads the tool's schema from `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`, then calls it through its own `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`) |
| 4 resume | pass: `--conversation <conversation_id>` continued the session, codeword remembered (68 s) |
| 5 interrupt | not run: stopped by hand in turn 3, just before agy called the slow tool |
| 6 cost | tokens only, with no USD: per-step `usage` (input, output, thinking, cache_read, total) and a total in `result.usage` |

Event format: `{"event":"init","conversation_id":…}`, then `{"event":"step_update","step_update":{step_index, state: ACTIVE|DONE, step_type: user_input|agent_response|tool|system_message, tool_name, tool_info{name, parameters, output}, text_delta, duration_seconds, usage}}`, then `{"event":"result","result":{status: SUCCESS, response, duration_seconds, num_turns, usage}}`. The check now prints these steps.

For a driver: `agy mcp add` is user-level (under `~/.gemini/antigravity-cli/`), so every agy session on the machine sees every registered server. Agents need their own rt-agent server, and an agent could call another agent's server by name through `call_mcp_tool`. The driver needs a per-agent config home, or a way to scope servers, before it can keep agents apart. `--input-format stream-json` could avoid the 14 s startup per message.
