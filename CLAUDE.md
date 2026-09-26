# Working in this repo

- Read `docs/architecture/README.md` before changing code. The spec is `docs/SPEC.md`. Where they differ, the spec wins, except for the deviations in `docs/architecture/spec-gaps.md`.
- Build in the slice order in `docs/architecture/build-plan.md`. Don't start a slice until the previous one is green.
- New board sections, procedures and event types go in the registries in `packages/protocol/src` (`sections.ts`, `procedures.ts`), never as special cases in the router or gateway.
- `packages/core` is pure: no `node:*`, no IO, no `Date.now()` or `Math.random()`. Time and ids come in through `ctx`.
- Use erasable TypeScript only (no enums, namespaces or constructor parameter properties). Relative imports use `.ts` extensions.
- Before pushing, run `pnpm check` (dependency rule, typecheck, tests).
- Any deviation from the spec gets a row in `spec-gaps.md` and an ADR, and goes to the human before merging.
