# ADR-0002: Separate connection liveness from model attention

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec marks an agent stale after 3 min without a hub call and releases its work after a 10-minute grace period. A model running a long build or test suite makes no hub calls for many minutes but is healthy, so it would lose its locks and tasks.

## Decision

Track two signals:
- **Connection liveness**: the rt-agent *process* pings the hub over the transport every 15 s. It keeps running while the model is busy, and it dies when the client session ends, because stdio servers are children of the session. A dropped connection marks the agent `disconnected`. It becomes `stale` after 3 min, and `gone` after the 10-minute grace period (F10 cleanup).
- **Attention**: the time since the last model tool call, counting Round Table calls and hook-reported calls. Past `attention_timeout` (default 15 min) the hub appends `roster.inattentive` and notifies the leader, who pings the agent. Attention never releases locks or tasks by itself.
- Activity freshness (5 min without `activity()`) only adds a reminder to the piggyback banner.

## Consequences

- A crashed session is detected within seconds, not minutes, because the socket closes.
- A hung model with a live process is caught by the attention timeout and handled by people (leader, then human), not by automatic cleanup.
