# ADR-0005: One serialized command bus for the whole hub

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The build brief suggests one command queue per project for isolation. But repo locks are shared across projects, and the global budget ceiling spans them all. With per-project queues, both need cross-queue coordination, which brings the races the queues were meant to avoid. SQLite allows one writer at a time anyway.

## Decision

- **One command bus** processes all commands one after another. Each command runs `decide` and appends its events, projections and delivery rows in a single SQLite transaction.
- Isolation is **logical**: every command and event carries its stream and project_id. A command that throws rolls back only itself, and the bus appends `project.degraded` on the `system` stream so the human sees it. Other projects keep running.
- Slow IO never runs on the bus. Reactors run git, tests, exports and timers outside it and report back with commands.
- The event log has three kinds of stream: `system`, `project:<id>` and `repo:<id>`.

## Consequences

- Throughput is bounded by one writer. At this scale (a handful of agents, human-speed events) it is far from a limit. Commands are expected to take well under 1 ms of CPU plus one fsync'd transaction.
- If scale ever demands it, the bus can be sharded by stream later, because commands already declare their stream.
