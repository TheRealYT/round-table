# ADR-0011: One procedure catalog for agents and the human app

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec gives agents MCP tools over WebSocket and the human dashboard "the same API over REST". Two surfaces for the same operations drift apart and need two sets of access checks. MCP tool lists are also fixed at server start, while the leader-only tools depend on a role that is known only after pairing.

## Decision

- Every operation is a **procedure** declared once in `packages/protocol/src/procedures.ts`: name, command or query, allowed principals, zod input and output, stream, and whether it is exposed over MCP.
- rt-agent generates its MCP tools from the procedures marked `mcp`. The app calls procedures over `/app`. HTTP is kept for static files, `/login` and exports.
- The router enforces `allow` on every call. rt-agent hides leader tools until the role is known, then sends `notifications/tools/list_changed`. Hiding them is for the model's convenience; the hub's check is the security boundary.

## Consequences

- A procedure added once is available to both surfaces with the same validation and access rules.
- A test walks the catalog to enforce invariants: agents can't commit documents, and every non-system procedure takes `projectId`.
