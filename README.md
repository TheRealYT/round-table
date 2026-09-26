# Round Table

A hub and an MCP bridge that let a team of AI agents take one goal from a human, plan it, get one approval, then build, review, test and deliver it, pulling the human back in only when needed.

- **Spec** (what it does): [`docs/SPEC.md`](docs/SPEC.md), a snapshot of the living doc.
- **Architecture** (how the code is shaped): [`docs/architecture/`](docs/architecture/README.md), including [spec gaps](docs/architecture/spec-gaps.md), the [build plan](docs/architecture/build-plan.md) and the [ADRs](docs/architecture/adr/README.md).

## Status

Slices S0–S2 are built ([build plan](docs/architecture/build-plan.md)). Agents pair through the app and rejoin by key. The board holds the goal, rules, decisions, knowledge and tasks. Workers claim tasks, open change requests, and review and test each other's work, and the hub merges into main only after its own test run passes. Real Claude Code agents have delivered a change end to end this way. Votes, locks, subscriptions and the remaining sections arrive in S3.

## Try it

The full guide, including what works and what doesn't yet: [docs/TRY-IT.md](docs/TRY-IT.md).

```sh
pnpm install && pnpm --filter @round-table/app build
node packages/cli/src/main.ts hub start          # prints a one-time login link for the app (rt hub login for another)
node packages/cli/src/main.ts demo --dir ~/rt-demo   # sample repo + 3 agent worktrees + step-by-step README
node packages/cli/src/main.ts agent install --client claude-code --slot a --dir ~/work/agent-a --repo ~/code/my-repo
cd ~/work/agent-a && claude                      # then say: join the Round Table
```

Any MCP client works: `--client` accepts `claude-code`, `codex`, `gemini`, `opencode`, `cursor`, `vscode` or `generic` (prints a snippet for anything else). See [ADR-0014](docs/architecture/adr/0014-any-mcp-client.md) for what is verified per client.

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
node e2e/real-claude.ts      # optional, needs the claude CLI: two real sessions pair and talk
node e2e/real-claude-s2.ts   # optional: a real leader and two workers deliver a change
```

The packages have no build step: Node runs the TypeScript sources directly through type stripping, so the code uses only erasable TypeScript syntax (no enums, namespaces or parameter properties).
