# Round Table

A hub and an MCP bridge that let a team of AI agents take one goal from a human, plan it, get one approval, then build, review, test and deliver it, pulling the human back in only when needed.

- **Spec** (what it does): [`docs/SPEC.md`](docs/SPEC.md), a snapshot of the living doc.
- **Architecture** (how the code is shaped): [`docs/architecture/`](docs/architecture/README.md), including [spec gaps](docs/architecture/spec-gaps.md), the [build plan](docs/architecture/build-plan.md) and the [ADRs](docs/architecture/adr/README.md).

## Status

Slices S0 and S1 are built ([build plan](docs/architecture/build-plan.md)). Agents pair through the app, rejoin by key, and message each other and the human, with real Claude Code sessions. The board, tasks and git arrive in S2.

## Try it

```sh
pnpm install && pnpm --filter @round-table/app build
node packages/cli/src/main.ts hub start          # prints a one-time login link for the app
node packages/cli/src/main.ts agent install --slot a --dir ~/work/agent-a
cd ~/work/agent-a && claude                      # then: /mcp__roundtable__join
```

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
pnpm check        # dependency rule + typecheck + unit and scenario tests
pnpm e2e          # builds the app, then Playwright against a real hub
node e2e/real-claude.ts   # optional: two real Claude Code sessions (needs the claude CLI)
```

The packages have no build step: Node runs the TypeScript sources directly through type stripping, so the code uses only erasable TypeScript syntax (no enums, namespaces or parameter properties).
