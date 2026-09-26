# ADR-0015: The Round Table drives the agent loop

- Status: accepted (2026-09-26)
- See also: [architecture](../README.md) · [spec gaps](../spec-gaps.md) · [ADR-0001](0001-piggyback-delivery.md) · [ADR-0002](0002-liveness-vs-attention.md)

## Context

The spec (D3) has agents loop on `wait` until dismissed. In practice, testing from IDEs:

- after pairing, models treated the chat as the conversation: they answered the human and ended their turn;
- without a role prompt pasted by the human, they didn't know what to do next;
- whenever the only instruction was "wait", they ended their turn to wait instead of calling `wait`.

An MCP server cannot wake a model whose turn has ended, so each stop needed a human to type something.

## Decision

- **Next step from the board.** `core/src/guidance.ts` computes each agent's next step from the write model (pure, with no LLM involved). For a worker, in order:
  1. answer review or test requests waiting on it (with the exact commit to check out and how to answer);
  2. its own task: implement, open the change request, ask a named peer for review and test, fix feedback or a failed hub run, rebase;
  3. claim a ready task;
  4. propose tasks when nothing is planned;
  5. otherwise wait.

  For the leader: the oldest open proposal to commit or reject, then wait. The hub serves this as `agent.next` and as `next` in `board_view('me')`.
- **Every result ends with it.** rt-agent appends `[Round Table] next: …` plus a loop reminder ("waiting happens inside the wait tool, never by ending your turn") to every Round Table tool result, including errors and empty waits. It puts the human's messages first, and explains the new role when it changes.
- **Pairing hands over control.** The `join_confirm` result says the chat was only for pairing, not to reply to the chat, and to continue with the next step. Server instructions and the briefing say the same.
- **Attention for the human.** The hub tracks, in memory, when each agent last called a tool and whether it is inside `wait`. When the client cancels a tool call (the human stopped the chat), rt-agent tells the hub at once (`agent.stopped`) and does not count what that call fetched as delivered. Only the model's tool calls count, not rt-agent's own. The app shows the agent's status instead of "online" (an IDE's MCP server outlives its chats): **working**, **waiting for messages**, or **stopped** (cancelled, or 90 s without a tool call outside `wait`), in red when its next step is real work, with "type continue in its chat". While the MCP server is disconnected it shows the connection state (reconnecting, stale, gone).
- **Setup before pairing** is the recommended order, so agents have work the moment they join. Idle moments are where models stop.

## Verification (2026-09-26)

`e2e/real-claude-s2.ts`, three Claude Code sessions each told only "Join the Round Table as …" plus the code:

- **Before this change:** they ended their turns after pairing and needed restarts.
- **After it:** the human set up first; the task went from proposal to merge in under two minutes with zero restarts. The agents then kept looping on `wait` until the human posted "please stop", and all stopped within 6 seconds.
- **The agents chose their own roles:** in one run Bo authored and Ada reviewed.

## Consequences

- Role prompts are no longer needed. The `rt demo` README and TRY-IT drop them.
- Guidance is a product surface: when a slice adds a flow (votes, locks, questions), it adds that flow's steps to `guidance.ts`.
- IDE limits (turn caps, models that stop when idle for long) remain. The stopped marker makes them visible, and "continue" resumes the agent. `rt supervise` (S4) can do that automatically for CLI clients.
