# ADR-0012: Security boundary, threat model, keys and hooks

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec puts security "at the doors" (pairing and key-signed rejoin) and keeps the human role only in the app. But agents run shell commands on the same machine, usually as the same OS user as the hub. They can reach any localhost port and read any file that user can read.

## Decision

- **Endpoints are split**: `/agent` sessions can only become `unpaired`/`worker`/`leader` principals. `/app` requires a cookie from a one-time login URL printed by the hub, plus `Host` and `Origin` checks against DNS rebinding and cross-site requests.
- **Keys**: a `KeyStore` port. The MVP ships a 0600 file store; an OS keychain backend comes later, because a native keychain module would complicate the Electron path.
- **Hook adapter** (Claude Code first): `rt hook <event>` talks to its slot's rt-agent over a unix socket. It logs every client tool call as `log_action`, denies tools while paused, denies known destructive patterns without a recorded human approval, and fails open (with a local log) when rt-agent is down.
- **Threat model**: protects against confused or prompt-injected agents (acting as the human, self-approval, direct board writes, forged human quotes, admitting agents, replayed rejoins). It does **not** protect against a deliberately malicious agent running as the same OS user, which can read the hub database. The documented mitigation is to run `rt-hub` as a separate OS user with a 0700 data directory.

## S0 findings (2026-09-26)

- A PreToolUse hook that talks to a unix socket answers in 5–13 ms, and the model receives the deny reason.
- Deny reasons must be factual (`[Round Table] Blocked: project paused by the human.`) and explained in rt-agent's MCP `instructions`. An imperative reason ("Commit WIP and call wait") was treated by the model as a possible prompt injection.

## Consequences

- The protections the spec cares about hold for the realistic failure (a misbehaving model), and the limit is written down instead of implied.
