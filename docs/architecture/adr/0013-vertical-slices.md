# ADR-0013: Build in vertical slices, spikes first

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md)

## Context

The spec's milestones build horizontal layers: protocol, then hub core, then board, then coordination, and only in M4 a real MCP client. The assumptions most likely to force redesign all sit at the MCP boundary: wait timeouts, interrupts, identity, tool lists and hooks. In that order they surface last, which is how a plan that "seems good in theory" gets rewritten during coding.

## Decision

Build in slices S0–S7 ([build-plan.md](../build-plan.md)). S0 checks the MCP and runtime assumptions with throwaway spikes. S1 is a walking skeleton in which a real Claude Code session pairs and chats through every layer. Each later slice adds depth to a loop that already works.

## Consequences

- The scope and the MVP definition of done are unchanged. Only the order changes.
- Early slices use a subset of sections and procedures, so the registries must be designed for growth from day one (they are).
