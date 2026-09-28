# ADR-0020: Settings with per-project overrides, and full-auto mode

- Status: proposed (2026-09-28); the leader-approval and hub-wide rules parts deviate from the spec and go to the human
- Related: spec D7 (human away), D8 (budgets), "Organization rules"

## Context

The human wants to set things once for all projects and override them per project. They also want to run a project without being there: "the leader takes approvals, human may not be available at all". The spec's Settings view (S5) lists budgets, timeouts and notification rules, and its plan gate is "one human approval".

## Decision

- **A settings registry in `protocol`** (`settings.ts`): every setting with its default, and a zod schema for a scope's overrides. Values resolve per leaf: default, then hub-wide, then the project's override. `settings.set` records a scope's whole override object as one event (`settings.changed`); `settings.get` returns the defaults, both scopes and the resolved values.
- **Autonomy:** `planApproval` is `human` (the default, as the spec says) or `leader`. In full auto the leader's commit is the approval: its new tasks become `ready` with cause `leader`, and the free workers are told. The human sees everything and can stop any agent.
- **Budget:** `projectUsd` warns at 80% (`budget.warned`) and at 100% stops the project's hub-run agents (`budget.reached`, then `agent.run_requested false`). A new limit resets the alerts.
- **Messages:** `workerBroadcast` is `fyi` (the default) or `off` (refused, name the recipients).
- **Agent defaults:** model and effort per role, used when neither the agent nor the start chose one, before the provider's.
- **Rules:** hub-wide `team` and `leader` rules. Projects add their own in the `rules` board section (`text`, `leaderText`, next to the check command). Hub-run agents get all that apply in their kickoff and hear about changes with their next turn. Agents joined from a chat read them on the board.
- **Notifications and tools:** browser notifications on or off, and the terminal on or off (ADR-0021).
- **Later, not built:** a guard slot for an action checker (a model that judges commands before they run). Its hook point is the Claude Code hook adapter from S6.

## Consequences

- Leader approval and hub-wide rules are deviations (spec-gaps rows 26, 29). The spec's behavior stays the default.
- Review and test by another agent stay required. A setting to relax the done rule was considered and left out: it would change the merge gate, and it wasn't asked for.
