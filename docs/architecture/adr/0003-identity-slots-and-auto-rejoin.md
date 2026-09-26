# ADR-0003: Identity slots and automatic rejoin

- Status: accepted (2026-09-26); partly superseded by [ADR-0016](0016-identity-by-join-name.md): the slot is optional, and without it identity comes from the join name
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec's `rejoin(agent_id)` is a model tool. After a restart or a context reset, the model doesn't know its agent_id. The spec also requires that the model never handles the key. Several agent sessions on one machine need separate identities.

## Decision

- rt-agent is started with `--slot <name>`, which `rt agent install` writes into the client's MCP config. The identity lives at `$RT_HOME/identities/<hubId>/<slot>.json` (0600) behind the `KeyStore` port and holds `agentId`, the Ed25519 private key (pkcs8) and the hub's public key.
- On startup, if the slot has an identity, rt-agent connects and runs the challenge-response rejoin **before** it serves the first tool call. The model then receives the resume view (tasks and locks if within grace, and its handoff note) as the result of its first call.
- The model is only involved in first-time pairing, and only to relay the match phrase and paste the one-time code. `rejoin` stays available as a manual retry tool.

## Consequences

- One slot means one agent identity. Running two sessions on the same slot is exactly the case that epoch fencing handles ([ADR-0004](0004-session-epoch-fencing.md)).
- "Remember" (keep the key across projects) is a flag on the identity on the hub's `system` stream. The slot file doesn't change.
