# ADR-0016: Agent identity by join name, not by config

- Status: accepted (2026-09-26)
- Supersedes part of: [ADR-0003](0003-identity-slots-and-auto-rejoin.md) (identity slots)
- See also: [ADR-0014](0014-any-mcp-client.md)

## Context

ADR-0003 bound an agent's identity to `--slot` in the MCP config. That fits Claude Code, where one folder is one agent. IDEs like Antigravity and Cursor have one global MCP config for every chat, so every chat got the same slot. Each new chat then rejoined as the same agent, and the hub's epoch fencing replaced the previous one: two chats became one agent. MCP gives a server no way to tell which conversation a tool call comes from.

## Decision

- **`--slot` is optional.** With it, nothing changes: one server, one agent, automatic rejoin at startup, and per-role tool lists.
- **Without it, identity comes from the join name.** `join_request {name}` maps the name to a slot ("Ada Lovelace" → `ada-lovelace`):
  - A name with a stored identity rejoins by key, with no code needed ("Welcome back").
  - A new name pairs as before, with the match phrase and code.
- **One server can carry several agents.** Each agent is an `AgentSession` with its own authenticated hub connection, key, inbox and next-step state. In this mode every tool except `join_request` takes an optional `as`, the name the agent joined with:
  - With one agent in the server, `as` isn't needed.
  - With several, a call without `as` is refused, and the message names the agents.
  - An unknown `as` is refused with how to join.
- **Pairing survives restarts.** A server restarted between `join_request` and the code finds the only pending request on disk (`KeyStore.listPending`).
- In this mode tool lists are always static; the hub enforces roles.

## Verification (2026-09-26)

- **Scenario tests:**
  - two servers sharing one key store, as when an IDE starts one per chat, are two agents and both stay online;
  - a later chat joining with a known name is that agent again, without a code;
  - one server carries two agents routed by `as`, and messages reach only the named agent;
  - pairing finishes after a restart.
- **Real Claude Code:** three separate conversations shared one MCP config with no slot. "as Ada" and "as Bo" became two agents, and a third conversation's "as Ada" rejoined Ada with no code.

## Consequences

- IDE setup is one config entry with no per-agent flags.
- Two chats that pick the same name are the same agent, and the newer one replaces the older, which is the intended meaning of a name. The app shows each agent's name.
- The name is the handle, so it should be unique per person and hub. The pairing ceremony still decides who gets a name the first time.
