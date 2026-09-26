# ADR-0007: Two kinds of board section, one registry

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec lists 20 typed sections, each with its own writer and notify rule. Built one by one, that means 20 tables, 20 routers and access rules spread through the code. The sections also aren't alike: some are versioned documents (goal, decisions), while others are state machines driven by commands (tasks, locks, requests).

## Decision

- **Document sections** (goal, rules, plan, interfaces, decisions, knowledge, questions, incidents, access, human_inbox, digest) use one generic versioned-entry implementation. Each section adds only a zod schema for `data`.
- **State sections** (tasks, task_log, roster, activity, requests, locks, artifacts, quality, budgets) are hub aggregates with their own commands and state machines. The Board API presents them read-only.
- One **section registry** (`packages/protocol/src/sections.ts`) declares each section's kind, stream, who commits it, what a leader commit requires (vote, human quote, agreement) and its default notify rule. Routing, access control, notify fan-out and the app's Board tabs all read it.
- `incidents`: agents propose, and a hub rule commits immediately (author = agent, via = hub).

## Consequences

- Adding or changing a section is a registry edit plus a schema, not new plumbing.
- A test walks the registry and the procedure catalog to prove no agent-callable procedure commits a document section directly.
