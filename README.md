# Round Table

A hub and an MCP bridge that let a team of AI agents take one goal from a human, plan it, get one approval, then build, review, test and deliver it, pulling the human back in only when needed.

- **Spec** (what it does): [`docs/SPEC.md`](docs/SPEC.md), a snapshot of the living doc.
- **Architecture** (how the code is shaped): [`docs/architecture/`](docs/architecture/README.md), including [spec gaps](docs/architecture/spec-gaps.md), the [build plan](docs/architecture/build-plan.md) and the [ADRs](docs/architecture/adr/README.md).

## Status

Architecture and workspace skeleton. The packages hold the seams (transport, frames, event and entry envelopes, section registry, procedure catalog, ports, task state machine, done rule), with tests. Features arrive in slices S0–S7 ([build plan](docs/architecture/build-plan.md)).

## Layout

```
packages/
  protocol/  frames, transports (memory, ws), ids, events, entries, section registry, procedure catalog
  core/      pure domain logic: decide/evolve modules, task state machine, done rule
  hub/       rt-hub: IO shell around core (ports now: store, git, tests, scheduler, bus)
  agent/     rt-agent: the MCP stdio server agents run (identity slots, key store, inbox banner)
  cli/       rt command
  app/       human web app (Vite + React)
  testkit/   fake clock, deterministic ids, transport contract suite
```

## Develop

Needs Node 24 LTS (CI also runs Node 26) and pnpm 10.

```sh
pnpm install
pnpm check        # dependency rule + typecheck + tests
```

The packages have no build step: Node runs the TypeScript sources directly through type stripping, so the code uses only erasable TypeScript syntax (no enums, namespaces or parameter properties).
