# ADR-0006: Durable and ephemeral events, with snapshots

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec requires both "replaying the event log rebuilds an identical board" and "raw event logs kept 90 days by default". Once the first events are pruned, replay from zero is impossible, and time travel to older moments breaks.

## Decision

- Every event type declares a durability. **Durable**: board entry versions, task state changes, change requests and merges, decisions, votes, human actions, audit, pairing and keys. **Ephemeral**: chat, activity reports, `log_action`, tool-call logs, heartbeats and delivery acks.
- Retention prunes only ephemeral events older than the retention window.
- A `snapshot` event holding the full write-model state of a stream is written every N events (default 5000) and always before a prune. Replay and `board.at(seq)` start from the nearest snapshot at or before `seq`.

## Consequences

- The board, decisions and history can be rebuilt forever. Chat older than the retention window is gone, as the spec intends.
- Time travel into a pruned range shows the board correctly but has no chat for that period.
