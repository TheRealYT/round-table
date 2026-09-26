# ADR-0010: Persisted timers and an injected clock

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec has more than a dozen timers: code expiry, request expiry, stale, grace, votes, question defaults, lock inactivity, task budgets. Built with `setTimeout`, they are non-deterministic, can't be tested with a fake clock and are lost on restart.

## Decision

- `core` receives `ctx = {now, ids}` and never reads the real clock or random numbers.
- A timer is an event: `timer.scheduled {timerId, dueAt, command}` and `timer.cancelled`. The Scheduler adapter keeps the earliest `dueAt`, and when it passes, dispatches the stored command through the bus like any other command.
- After a restart, the scheduler reloads pending timers from the write model. Overdue timers fire right away, in order.
- `testkit` provides `FakeClock`. Scenario tests advance time explicitly.

## Consequences

- Every timeout in the spec can be tested in milliseconds.
- Timer firing order is deterministic, which replay depends on.
