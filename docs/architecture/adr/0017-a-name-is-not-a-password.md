# ADR-0017: A name is not a password: chat tokens and human-approved takeover

- Status: accepted (2026-09-26)
- Supersedes part of: [ADR-0016](0016-identity-by-join-name.md) (rejoin by name, `as`)
- See also: [ADR-0012](0012-security-boundary-and-threat-model.md)

## Context

ADR-0016 made an IDE chat's identity the name it joins with. The key for that name is stored by rt-agent, which every chat of the IDE shares. So any chat that said "as Ada" got Ada's key and was in, with no code and nothing for the human to see, and the `as` field let any chat act as any agent in the server without even joining. The spec's rejoin rule ("the agent proves it holds the private key") assumes the key belongs to one agent. In an IDE it belongs to the rt-agent install, which every chat shares, so holding it proves nothing about which chat is calling.

## Decision

Named mode (no `--slot`):

- **Chat token.** `join_confirm` gives the chat a random token (`ada.k3f9q2m8`). Every tool except `join_request` and `join_confirm` requires it as `token`, which replaces `as`. rt-agent stores only its SHA-256 hash with the identity, so the token can't be read from disk. Every result repeats it, so it survives context compaction.
- **A paired name needs the human.** `join_request` with a name that already has a key sends a **resume request**: an ordinary pairing request signed by the existing key. The hub marks it `resumes: <agentId>` and pins it to that agent's project. The app shows "A new chat asks to continue as Ada". Allow gives a code, and `join_confirm` with it records `pairing.resumed`, keeps the same agent id, and issues a new token.
- **The old chat is out.** Its token no longer matches. In the same server its next call (and a `wait` in flight) fails with "another chat now works as this agent; stop working in this chat". Its undelivered messages go to the new chat. From another server process, the hub fences the old session. A process whose token was replaced doesn't take the agent back when it reconnects.
- A chat that still holds its token carries on after restarts without the human (the spec's "rejoin needs no human" still holds for the chat that paired).

Fixed slot (`--slot`, `rt agent install` for Claude Code): unchanged. One folder is one agent and the server rejoins at startup, as the spec's rejoin describes.

## Consequences

- A new chat can't become an existing agent without the human seeing the phrase and pasting a code.
- A chat that loses its token (a new conversation, a hard context reset) needs the human again. That costs one approval, and it is the point.
- The threat model is unchanged. A same-user process that reads the key file and speaks the protocol directly is out of scope (ADR-0012). The token guards against chats, which only reach the hub through rt-agent's tools.
