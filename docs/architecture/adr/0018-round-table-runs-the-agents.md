# ADR-0018: Round Table runs the agents

- Status: accepted (2026-09-26), by the human after the S8 spike
- Supersedes as the main path: [ADR-0015](0015-round-table-drives-the-loop.md) (driving a chat through tool results), [ADR-0016](0016-identity-by-join-name.md) and [ADR-0017](0017-a-name-is-not-a-password.md) (chat identity). They stay for agents that join from a chat.
- Evidence: [`spikes/s8-drivers/FINDINGS.md`](../../../spikes/s8-drivers/FINDINGS.md)

## Context

Joining from a chat (IDE, desktop app) leaves the loop to the client: the model ends its turn and nothing can wake it, "online" means a server process rather than a working agent, clients differ in timeouts and turn limits, some ask the human to approve every tool call, and a chat has no identity of its own. Each fix (next-step lines, attention markers, chat tokens) patched a symptom of one cause: Round Table didn't own the loop.

The coding CLIs run headless. S8 showed that Claude Code resumes a session per message, keeps a long-lived process fed messages on stdin, stops mid-turn on an interrupt, reports every step, its tokens and cost as JSON, calls our MCP tools, and runs without approval prompts.

## Decision

- **Providers.** The human configures each CLI once in the app: kind (Claude Code, Codex, Gemini CLI, Cursor, opencode), binary, sign-in (the CLI's own login, or an API key), default model, extra arguments, and an instance limit. Kinds live in a registry in `protocol` (`providers.ts`). A kind can start agents only once its **driver is verified** by the S8 check; the others can be configured but not started.
- **Credentials** are kept by the hub in a separate owner-only file, never in the event log. The log records only that one was set or cleared. They reach the agent process as environment variables.
- **Driven agents.** The human starts one or more agents from a provider into a project. The hub issues each one's identity itself (no pairing), gives it a git worktree of the project's repository (or an empty folder), and starts the CLI with rt-agent as its MCP server in **driven mode**.
- **The supervisor** (hub) owns the loop:
  - It delivers messages as the agent's next turn, and wakes an idle agent when the board gives it work (the same next step as ADR-0015).
  - It acks deliveries when the turn ends.
  - It restarts a crashed process by resuming its CLI session, with backoff.
  - It stops or interrupts on the human's command.
- **Status is exact:** starting, working, idle, stopped, crashed. Cost and tokens per turn come from the CLI's own report.
- **Drivers** sit behind one port in `hub` (`Driver`). Workspace preparation (identity file, worktree, MCP command) is a port (`AgentHost`) implemented in `cli`, so `hub` doesn't depend on `agent`.
- Joining from a chat stays as a fallback for clients without a verified driver.

## Consequences

- No `wait` long-polling, tool timeouts, "type continue", attention guesses, pairing codes or chat tokens for driven agents.
- An agent's tools and filesystem are limited by where the hub runs, not by per-call approvals. Run the hub (and its agents) in a sandbox. As root, Claude Code needs `IS_SANDBOX=1`.
- Users pay through their CLI subscriptions or API keys; the hub shows what each turn cost.
