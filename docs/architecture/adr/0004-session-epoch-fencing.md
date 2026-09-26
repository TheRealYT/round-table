# ADR-0004: Session epochs fence old connections

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec says two live sessions with the same key mean the key may have been copied, and both should be paused. But stdio MCP servers restart routinely (client reloads, crashes), and the new process often connects before the old socket has closed. Taken literally, the rule would pause agents on every restart.

## Decision

- Each successful authentication increments the agent's `epoch` (an event on the `system` stream). The gateway rejects any frame carrying a lower epoch with `fenced`. The fenced rt-agent tells its model that the session was replaced and stops serving tools.
- The spec's pause-and-alert fires only on **ping-pong**: the same key re-authenticating more than 3 times within 2 minutes while another epoch is live. That pattern means two processes are fighting over one identity.

## Consequences

- Normal restarts are silent, and the newest session wins.
- A copied key is still caught as soon as both copies are actively used.
