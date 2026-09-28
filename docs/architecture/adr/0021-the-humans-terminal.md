# ADR-0021: Read-only git and a terminal for the human

- Status: proposed (2026-09-28); the terminal is a deviation (spec-gaps row 30) and goes to the human

## Context

To see what a team did, people want the repository in the app: the task branches, what each one changes, the history, each agent's worktree with its uncommitted work, and the files. They also want to run a command without leaving the app (build, try the game, inspect a worktree). The spec keeps the human's actions in the app and never over MCP, and has no shell.

## Decision

- **Read-only git** as human-only queries in the procedure catalog:
  - `git.branches` (ahead/behind main, last commit, the task on the branch), `git.log` and `git.show`;
  - `git.diff` (base...head), `git.worktrees` (branch, uncommitted changes, which agent) and `git.worktree_diff`;
  - `git.tree` and `git.file` (at a ref, or on disk in a worktree).
  - Nothing writes.
  - Refs and paths are checked before they reach git, so they can't become options or leave the repository. A worktree is named by its path and must be one of the repository's worktrees.
- **The terminal** is a shell on the hub machine, opened in the repository or in one of its worktrees and streamed over its own WebSocket, `/term`:
  - It is not a procedure, because a raw byte stream isn't part of the event model. Nothing typed is logged.
  - Access requires the human's login cookie, a local Host, and a same-origin Origin (no other site can open it). The `tools.terminal` setting can turn it off.
  - It uses `node-pty` where it is installed (an optional dependency with prebuilds for macOS and Windows; Linux builds it). Otherwise it uses a small `python3` PTY helper, so Linux and macOS need no native build.
- The app shows these as a **Code tab** and a terminal dock with several tabs. The dock loads only when opened.

## Consequences

- Whoever holds the login cookie has a shell as the hub's OS user. That was already true in effect, since agents run as that user without approval prompts (ADR-0012, ADR-0018). The terminal just makes it visible and deliberate.
- Commits made by agents now show in the app without their reports. This is part of S6's "commits appear in logs", read on demand rather than recorded as events.
