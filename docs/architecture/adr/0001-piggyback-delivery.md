# ADR-0001: Piggyback delivery and a capped `wait`

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec has agents "listen" by long-polling `wait`, and says human messages interrupt `wait` immediately. Two facts get in the way. First, the hub can only reach a model when the model calls a tool: MCP server-to-client notifications are handled by the client and never reach the model's context. Second, MCP TypeScript SDK clients time out a request after 60 s by default, so a `wait` that returns "at least every 60 s" races the client timeout. An agent that is busy building doesn't call `wait` at all, so it would never see the human until it finished.

## Decision

- `wait` is capped at **50 s** by default (`settings.wait_max_ms`). S0 checks whether the client resets its timeout on progress notifications. If it does, rt-agent sends progress every 20 s and the cap can grow.
- A pending `wait` resolves immediately on `human` or `critical` delivery rows, after a ~2 s coalescing window for `direct` and `normal`, and on timeout otherwise. An empty result is a few tokens (`{"items":[]}`), so idle loops stay cheap.
- **Piggyback**: the hub pushes inbox counts to rt-agent whenever they change. rt-agent appends a one-line banner to *every* Round Table tool result and puts `human`/`control` items inline. The model sees the human at its next Round Table call, even mid-task.
- Delivery rows are acked by rt-agent on its next call (at-least-once). The model never handles a cursor.

## Consequences

- The spec's "human first" holds whenever the model touches the Round Table. With the hook adapter ([ADR-0012](0012-security-boundary-and-threat-model.md)) it also holds at any tool call.
- The worst-case delay for a human message to an agent that makes no Round Table or hooked calls is the length of its current tool call. This is documented.
- Tool results get one extra line of text.
