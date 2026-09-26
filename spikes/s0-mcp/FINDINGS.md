# S0 findings (2026-09-26)

Client: Claude Code 2.1.283 in headless mode (`claude -p`), MCP TypeScript SDK 1.30.1, Node 24.21.0.
Reproduce: `pnpm install --ignore-workspace` here, then the commands in the table (see `mcp-*.json`, `hooks.json`).

| # | Question | Result | Consequence |
|---|---|---|---|
| 1 | How long can one MCP tool call run? | Exactly **60 s**, then Claude Code aborts it: `MCP server "spike" tool "sleep" timed out after 60s`. The server sees `SdkError: Request timed out` on the abort signal. | `wait` must return before the client timeout. |
| 2 | Do progress notifications extend it? | **No.** Claude Code sends a `progressToken`, and progress every 10 s was delivered, but the call was still aborted at 60 s. | Progress can't be used to hold a long wait open. |
| 3 | Can the timeout be raised? | **Yes**: `MCP_TOOL_TIMEOUT` in the settings `env` (e.g. `--settings` or `.claude/settings.local.json`) let a 75 s call finish. | `rt agent install` writes `MCP_TOOL_TIMEOUT=300000` into the worktree's local settings and starts rt-agent with `--wait-max-ms 240000`. Without install, rt-agent defaults to 50 s. |
| 4 | Does `tools/list_changed` work mid-session? | **Yes.** After `become_leader` enabled a new tool, the model saw it and called it in the same run. | Leader tools appear after the role is known (ADR-0011) as planned. |
| 5 | Can a PreToolUse hook deny through a unix socket fast enough? | **Yes**: 5–13 ms per hook round trip. The model receives the reason as `PreToolUse:Bash hook error: <reason>`. | The hook adapter design (ADR-0012) holds. |
| 6 | Does the model act on text the server adds to results? | **Not without context.** With no server instructions, it flagged both the banner `⟪inbox: 1 human (call wait now)⟫` and the hook reason "Commit WIP and call wait" as possible prompt injections and ignored them. **With** MCP server `instructions` explaining the `[Round Table]` status line, and factual wording (`[Round Table] inbox: 1 human message waiting (priority: human). Read it with wait.`), the model called `wait` right away and followed the human's message. | Piggyback text is factual, never imperative, always prefixed `[Round Table]`, and defined in the server `instructions`. The same goes for hook deny reasons. |
| 7 | node:sqlite as the single writer | Node 24.21 ships SQLite 3.53.4 with WAL and FTS5, and no experimental warning. One transaction per command (3 event inserts, 1 upsert, 1 FTS insert): **3,700 cmd/s** with `synchronous=FULL`, 6,600 with `NORMAL`. | Use node:sqlite with WAL and `synchronous=FULL`. Throughput is far beyond need. |
| 8 | Type stripping through workspace symlinks | Node runs `.ts` sources of workspace packages linked via `node_modules`. | No build step for Node packages. |
