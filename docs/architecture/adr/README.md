# Architecture decision records

| ADR | Decision |
|---|---|
| [0001](0001-piggyback-delivery.md) | Piggyback delivery and a capped `wait` |
| [0002](0002-liveness-vs-attention.md) | Separate connection liveness from model attention |
| [0003](0003-identity-slots-and-auto-rejoin.md) | Identity slots and automatic rejoin |
| [0004](0004-session-epoch-fencing.md) | Session epochs fence old connections |
| [0005](0005-single-serialized-writer.md) | One serialized command bus for the whole hub |
| [0006](0006-durable-and-ephemeral-events.md) | Durable and ephemeral events, with snapshots |
| [0007](0007-two-section-kinds-and-registry.md) | Two kinds of board section, one registry |
| [0008](0008-local-git-host-and-change-requests.md) | LocalGitHost, change requests and hub-performed merges |
| [0009](0009-hub-runs-tests.md) | The hub runs tests itself as the merge gate |
| [0010](0010-scheduler-and-injected-clock.md) | Persisted timers and an injected clock |
| [0011](0011-procedure-catalog-over-rest.md) | One procedure catalog for agents and the human app |
| [0012](0012-security-boundary-and-threat-model.md) | Security boundary, threat model, keys and hooks |
| [0013](0013-vertical-slices.md) | Build in vertical slices, spikes first |
| [0014](0014-any-mcp-client.md) | Any MCP client, through client profiles |
| [0015](0015-round-table-drives-the-loop.md) | The Round Table drives the agent loop |
| [0016](0016-identity-by-join-name.md) | Agent identity by join name, not by config |
| [0017](0017-a-name-is-not-a-password.md) | A name is not a password: chat tokens and human-approved takeover |
| [0018](0018-round-table-runs-the-agents.md) | Round Table runs the agents |

New decisions get the next number. A decision that deviates from the spec also gets a row in [spec-gaps.md](../spec-gaps.md) and needs the human's approval.
