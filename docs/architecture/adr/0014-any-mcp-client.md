# ADR-0014: Any MCP client, through client profiles

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md) · [ADR-0001](0001-piggyback-delivery.md) · [ADR-0011](0011-procedure-catalog-over-rest.md)

## Context

The spec says "Bring your own: any MCP client joins the hub". S0 and S1 were checked with Claude Code, and three behaviors rt-agent leaned on turned out to be client features, not MCP guarantees:

- the tool timeout, and how to raise it (Claude Code: `MCP_TOOL_TIMEOUT`);
- `notifications/tools/list_changed`, used to show tools per role;
- MCP server `instructions`, used to define the `[Round Table]` status line (S0 finding 6).

Other clients differ, and their project config lives in different files.

## Decision

- rt-agent gets a **client profile** per client (`packages/agent/src/clients.ts`): where `rt agent install` writes the project config, the tool timeout it can set, the resulting `wait` cap, and whether dynamic tool lists and server instructions are known to work.
- Anything not verified against a real session falls back to the safe choice:
  - **`wait` under 50 s**, unless the profile raises the client's tool timeout.
  - **Static tools**: every tool stays listed. Descriptions say "Leader only." or "Workers only.", and the hub's ACL remains the security boundary. Calling a tool before pairing gets a plain "not paired yet: call join_request first".
  - **Briefing**: the protocol rules ride on the first successful tool result of each session, and the key tools (`join_request`, `join_confirm`, `wait`) carry the essentials in their descriptions, which every client shows the model.
- `rt agent install --client <id>` supports `claude-code`, `codex`, `gemini`, `opencode`, `cursor`, `vscode`, and `generic` (prints a stdio snippet). `rt agent run --client <id>` picks the profile's defaults, and `--wait-max-ms` / `--tools dynamic|static` override them.
- Client hooks (pause enforcement, action logging) stay an optional adapter per client. Without one, the piggyback status line is the delivery path for every client.

## Verification (2026-09-26)

| Client | Version | Project config | Checked |
|---|---|---|---|
| Claude Code | 2.1.283 | `.mcp.json` + `.claude/settings.local.json` | runtime: timeout, `MCP_TOOL_TIMEOUT`, list_changed, instructions, pairing and messaging end to end |
| Codex CLI | 0.157.1 | `.codex/config.toml` (read only for trusted projects) | config: `codex mcp list/get` show the server, env and `tool_timeout_sec = 300` |
| Gemini CLI | 0.61.0 | `.gemini/settings.json` (disabled in untrusted folders) | config: `gemini mcp list` starts rt-agent and reports Connected |
| opencode | 1.18.32 | `opencode.json` | config: `opencode mcp list` starts rt-agent and reports connected |
| Cursor, VS Code | — | `.cursor/mcp.json`, `.vscode/mcp.json` | from their docs only |

No model credentials were available for Codex, Gemini or opencode, so their runtime behavior (timeouts, list_changed, instructions) is unverified. Their profiles use the safe defaults until someone checks and flips a flag.

## Consequences

- A new client is a profile entry plus a test. Nothing in the hub changes.
- Static tool lists cost some context (all tools are listed) and rely on descriptions for role hints. The hub still refuses anything a role may not do.
