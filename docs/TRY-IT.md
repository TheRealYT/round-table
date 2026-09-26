# Try Round Table (state after S2)

This is a guide to testing the current build by hand: what you need, three ways to run it, and an honest list of what works and what doesn't yet.

## What you need

- Node.js 24 LTS (26 also works) and pnpm 10
- git
- An MCP client for your agents. Claude Code is tested end to end. Codex CLI, Gemini CLI and opencode are set up and seen to connect, but no real session has been run in them yet (see [ADR-0014](architecture/adr/0014-any-mcp-client.md)).
- A browser on the same machine. The hub only listens on 127.0.0.1.

```sh
git clone <this repo> round-table && cd round-table
pnpm install
pnpm --filter @round-table/app build
alias rt="node $PWD/packages/cli/src/main.ts"   # optional shorthand used below
```

## Path A: guided demo (recommended, about 10 minutes)

```sh
rt hub start                        # terminal 1, keep it running; open the login link it prints
rt demo --dir ~/rt-demo             # add --client codex|gemini|opencode|cursor|vscode for another client
```

`rt demo` creates `~/rt-demo/repo`, a sample repository with `greeting.txt` and a test `sh test.sh`. It also creates one git worktree per agent (`lead`, `ada`, `bo`), each set up for your client. It prints the steps and saves them in `~/rt-demo/README.md`. In short:

1. **Set the project up first**, so agents have work the moment they join. In the app, add a project in the sidebar. Under **Setup**:
   - set the goal (e.g. "Change greeting.txt so it reads exactly: hello there");
   - attach `~/rt-demo/repo`;
   - set the test command to `sh test.sh`.
2. Open three terminals, one each in `~/rt-demo/lead`, `~/rt-demo/ada` and `~/rt-demo/bo`. Start your client in each and say "Join the Round Table as Lead" (then Ada, then Bo).
3. Each agent shows a match phrase. In the app, under **Pairing**, check it matches, allow it into your project, and paste the code into that agent's chat.
4. Click **Make leader** on Lead. That is all the chat is for. From here the Round Table drives each agent: every tool result ends with a `[Round Table] next` line computed from the board, and the agents keep working through their tools. You don't paste any role prompts.
5. When a proposed task appears under **Tasks**, click **Approve plan**. Then watch the claim, the change request, the review and test by another agent, the hub's own test run, and the merge.
6. When it's done, post "The goal is done, please stop" from the composer. The agents stop.
7. Check the result: `git -C ~/rt-demo/repo log --oneline --graph main`.

Lost the login link? Run `rt hub login`.

## Path A2: add it to any IDE by hand (Cursor, Antigravity, VS Code, …)

With the hub running, add this stdio server to the IDE's MCP config. Use absolute paths, and for `command` use the output of `which node` (Node 24):

```json
{
  "mcpServers": {
    "roundtable": {
      "command": "/usr/local/bin/node",
      "args": ["/ABS/PATH/round-table/packages/cli/src/main.ts", "agent", "run", "--hub", "ws://127.0.0.1:7777"]
    }
  }
}
```

- **Don't put `--slot` in an IDE's config.** A fixed slot makes every chat started from that config the same agent: each new chat rejoins as it and replaces the previous one. Without `--slot`, an agent's identity comes from the name it joins with:
  - "Join the Round Table as Ada" in one chat and "… as Bo" in another are two agents.
  - A new chat that says "… as Ada" is Ada again, and needs no code.
  - If the IDE runs one server for all chats, that server carries all the agents, and each chat's tool calls name the agent they belong to.
- Where to put it:
  - **Cursor:** Settings → MCP → Add new MCP server (`~/.cursor/mcp.json`).
  - **Antigravity:** Agent panel → … → MCP Servers → Manage → View raw config (`mcp_config.json`).
  - **VS Code:** `.vscode/mcp.json`, with `"servers"` instead of `"mcpServers"` and `"type": "stdio"`.
- `rt agent install --client generic` prints this entry for you.

## Path B: fully automatic (Claude Code, about 2 minutes)

```sh
node e2e/real-claude.ts      # two real sessions pair through the app and message each other
node e2e/real-claude-s2.ts   # a real leader and two workers deliver a change to a sample repo
```

The second script plays the human. It sets up the project, pairs three agents (each told only "Join the Round Table as …" and given its code), approves the plan, and says "stop" at the end. Everything in between is driven by the Round Table. It prints the agents' transcripts file, the change request and the resulting git graph. It needs the `claude` CLI to be logged in. Last run: the task was done in under two minutes, with zero restarts, and all agents stopped within seconds of being told to.

## Path C: your own repository

```sh
rt agent install --client claude-code --slot ada --dir ~/work/ada --repo ~/code/your-repo
```

Pairing and setup are the same as in path A. Things to know:

- **Keep `main` unchecked-out** in the repository you attach, for example with `git switch --detach` in its main checkout. The hub moves `main` when it merges, which would leave a checkout of it out of date. The app warns you when this is the case.
- **The test command runs in a fresh worktree** of main plus the change, so it must install its own dependencies, e.g. `npm ci && npm test`. It runs with your user's permissions, without a sandbox.
- **Agents need git access to the repository**: their worktrees share the repository's branches, and there is no push or pull. The MVP is local only.

## What works now

| Area | Works | Notes |
|---|---|---|
| Pairing | Match phrase, one-time code (8 characters, 5 minutes, 3 attempts), allow into a new or existing project, deny, block origin | The code is stored only as a hash. |
| Identity | Key-signed rejoin after restarts, the newest session wins, older sessions are shut out | rt-agent does this itself; the model never sees the key. |
| Liveness | Agents are marked disconnected at once, stale after 3 minutes, and gone after 10 minutes | Coming back within the grace period resumes the agent. |
| Messages | Agent to agent, to everyone, human instructions from the composer | The human's messages and critical messages reach a busy agent on its next Round Table tool call. |
| Board | Goal, rules (test command), decisions, knowledge, tasks | Agents propose; the leader commits or rejects; stale proposals are sent back (D5). |
| Tasks | Plan approval by the human, claim and release (workers only), one branch per task | |
| Change requests | Open, refresh after new commits, review and test requests, verdicts tied to the exact commit | Nobody reviews their own work; the leader never reviews. |
| Merge gate | The hub merges main + the change in a scratch worktree, runs the test command, and moves main by compare-and-swap | A failing run or a conflict leaves main untouched and sends the task back to the author. |
| Agent loop | Every tool result carries the next step from the board; agents keep working through tools until told to stop; the app flags idle agents | No role prompts needed. |
| App | Login, Pairing, projects, agents with live state, activity and idle warnings, Setup, task board, change requests, feed, composer | Updates live. |
| Clients | Claude Code (verified in real sessions); Codex, Gemini CLI, opencode (config verified); Cursor, VS Code (from their docs) | `rt agent install --client …` |
| Durability | Hub restart keeps everything; agents reconnect and resume; merges that were interrupted resume | |

## What doesn't work yet

| Missing | Comes in | Workaround today |
|---|---|---|
| Team votes (changing rules or the plan through the leader), interfaces | S3 | The human edits rules in the app. |
| File locks, subscriptions, info and notify-on-done requests, board search | S3 | Agents coordinate with `send`. |
| Incidents, questions, the human inbox, `ask_human` | S3/S4 | Agents `send` to everyone; you read the feed. |
| Several goals or phases per project, roll call, onboarding view, budgets, pause and stop | S4 | The composer can tell agents to stop, but nothing enforces it. |
| Cleanup when an agent leaves or is gone (release tasks, reassign reviews) | S4 | Reassign by telling the agents. |
| Detecting a hung model (the attention timeout); pausing both sessions of a duplicated key | S4 | |
| Home, Inbox, Logs with time travel, Metrics, History, Settings in the app | S5 | |
| Git watcher (commits logged without agents reporting), BOARD.md export, retro, retention, hook adapter | S6 | |
| App login surviving a hub restart | later | `rt hub login` |
| Real sessions in Codex, Gemini CLI or opencode | needs credentials | Try one and report back; its profile uses safe defaults. |

## How the agent loop works

- **The chat only starts a session.** After `join_confirm`, the agent is told that the Round Table drives it, not the chat.
- **Every Round Table tool result ends with `[Round Table] next: …`,** computed by the hub from the board. For a worker the order is: answer a review or test request waiting on you, then work on your own task (implement, open the change request, ask for review and test, fix feedback, rebase), then claim a ready task, then propose tasks for the goal. The leader is told which proposal to commit or reject next. Otherwise the step is "call wait", and waiting happens inside the `wait` tool, never by ending the turn.
- **All communication goes through the tools:** `send`, `request`, `respond`, `board_propose`. You talk to agents from the app's composer; your messages reach them first.
- **The loop ends when you (or the leader) say so,** e.g. by posting "please stop" from the composer.
- **Limits you can't design away:** an MCP server can't wake a model whose turn has ended, and some IDEs pause an agent after a number of tool calls in one turn. If that happens, the app marks the agent **Idle** (in red if work is waiting for it). Type "continue" in that agent's chat.

## Things worth trying

- **Interrupt.** Send an instruction from the composer while an agent is working. It should act on it at its next Round Table tool call.
- **Restart.** Kill an agent's client and start it again in the same folder. It rejoins by itself; the feed shows a new session.
- **Stale approval.** After Bo approves, ask Ada to commit one more change. The old approval stops counting and the task goes back to review.
- **Failing test.** Ask the author to make `greeting.txt` contain "broken". Even if the tester says pass, the hub's own run fails and main doesn't move.
- **Conflict.** Change `greeting.txt` on main yourself (`git -C ~/rt-demo/repo commit` from a separate worktree, then `git update-ref`) before the merge. The author is asked to rebase.
- **Access.** Ask an agent to call `board_commit` or `pairing.allow`. The hub refuses.

## If something goes wrong

- **"Hub unreachable" in the app, or tools failing with "hub is unreachable":** is `rt hub start` still running? rt-agent reconnects on its own once the hub is back.
- **An agent stopped, or the app marks it Idle:** type "continue" in its chat. If it keeps stopping right after joining, set the project up before pairing, so it has work straight away.
- **An agent answers you in the chat instead of working:** say "Follow the Round Table's next steps." Its instructions and every tool result tell it the same.
- **An agent says it isn't paired after a restart:** start the client in the same folder. The identity belongs to the slot (the folder's config), not to the chat.
- **The login link expired:** run `rt hub login`.
- **Start over:** stop the hub and delete `~/.config/round-table` (or `$RT_HOME`) and the demo folder.
- **The hub's data** lives in `~/.config/round-table/hub/hub.db` (SQLite, append-only event log). It's safe to inspect while the hub is stopped.
