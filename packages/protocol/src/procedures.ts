import { z } from 'zod';
import { AgentId, ChangeRequestId, PairingId, ProjectId, RequestId, Sha, TaskId, TicketId, VoteId } from './ids.ts';
import { ControlAction, MessageType, Priority } from './message.ts';
import type { PrincipalKind } from './principal.ts';
import { SECTION_NAMES } from './sections.ts';

/**
 * The procedure catalog (ADR-0011): every operation, for agents over MCP and for the human app,
 * declared once. The router validates `input`, checks `allow` against the caller's principal and
 * routes commands to the bus and queries to the read models. rt-agent derives its MCP tools from
 * the procedures marked `mcp: true`.
 *
 * Output schemas are filled in by the slice that implements each procedure (see build-plan.md);
 * until then they are `z.unknown()`.
 */
export interface ProcedureDef {
  name: string;
  kind: 'command' | 'query';
  allow: readonly PrincipalKind[];
  /** Which stream the procedure's events go to (commands) or read from (queries). */
  stream: 'system' | 'project' | 'repo';
  /** Exposed to agents as an MCP tool. Human-only procedures never are. */
  mcp: boolean;
  summary: string;
  input: z.ZodType;
  output: z.ZodType;
}

function proc<const N extends string>(def: ProcedureDef & { name: N }): ProcedureDef & { name: N } {
  return def;
}

const Section = z.enum(SECTION_NAMES as [string, ...string[]]);
const Recipients = z.union([z.literal('all'), z.string().min(1), z.array(AgentId).min(1)]);
const Paths = z.array(z.string().min(1)).min(1);
const pending = z.unknown();

/** Human-app procedures on a project carry `projectId` explicitly; agent calls are scoped by their session. */
const inProject = <T extends z.ZodRawShape>(shape: T) => z.object({ projectId: ProjectId, ...shape });

const AGENTS = ['worker', 'leader'] as const;

export const PROCEDURES = [
  // ── Pairing and session (spec: Pairing, Rejoin, F9, F10) ───────────────────────────────
  proc({
    name: 'join_request',
    kind: 'command',
    allow: ['unpaired'],
    stream: 'system',
    mcp: true,
    summary: 'Start pairing; returns request id, hub public key and a match phrase to show the human.',
    input: z.object({
      name: z.string().min(1).max(64),
      client: z.string().min(1),
      tags: z.array(z.string()).default([]),
      capabilities: z.array(z.string()).default([]),
      // Filled in by rt-agent from the slot's key; the model never sees it (ADR-0003).
      publicKey: z.string().min(1),
    }),
    output: z.object({ requestId: PairingId, hubPublicKey: z.string(), matchPhrase: z.string() }),
  }),
  proc({
    name: 'join_confirm',
    kind: 'command',
    allow: ['unpaired'],
    stream: 'system',
    mcp: true,
    summary: "Finish pairing with the human's one-time code; signed by rt-agent with the new key.",
    input: z.object({ requestId: PairingId, code: z.string().length(8), signature: z.string().min(1) }),
    output: pending,
  }),
  proc({
    name: 'rejoin',
    kind: 'command',
    allow: ['unpaired'],
    stream: 'system',
    mcp: true,
    summary: 'Challenge-response rejoin. rt-agent does this automatically at startup; exposed as a manual retry.',
    input: z.object({ agentId: AgentId }),
    output: pending,
  }),
  proc({
    name: 'hub.info',
    kind: 'query',
    allow: ['unpaired', 'worker', 'leader', 'human'],
    stream: 'system',
    mcp: false,
    summary: 'Hub id, public key and protocol version. rt-agent reads it first to find its identity slot.',
    input: z.object({}),
    output: z.object({ hubId: z.string(), hubPublicKey: z.string(), version: z.number().int() }),
  }),
  proc({
    name: 'agent.next',
    kind: 'query',
    allow: ['worker', 'leader'],
    stream: 'project',
    mcp: false,
    summary: 'rt-agent internal: the agent’s next step, computed from the board; attached to every tool result.',
    input: z.object({}),
    output: z.object({ tool: z.string(), step: z.string() }),
  }),
  proc({
    name: 'agent.stopped',
    // Operational state only (no events), like wait: served by the router, not the bus.
    kind: 'query',
    allow: ['worker', 'leader'],
    stream: 'project',
    mcp: false,
    summary: 'rt-agent internal: the client cancelled a tool call (e.g. the human stopped the chat); shown to the human at once.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  }),
  proc({
    name: 'session.challenge',
    kind: 'command',
    allow: ['unpaired'],
    stream: 'system',
    mcp: false,
    summary: 'rt-agent internal, step 1 of rejoin: hub returns {nonce, hubId, ts} signed by the hub key.',
    input: z.object({ agentId: AgentId }),
    output: z.object({ nonce: z.string(), hubId: z.string(), ts: z.number().int(), hubSignature: z.string() }),
  }),
  proc({
    name: 'session.prove',
    kind: 'command',
    allow: ['unpaired'],
    stream: 'system',
    mcp: false,
    summary: 'rt-agent internal, step 2 of rejoin: signed challenge; opens a new epoch and fences older ones (ADR-0004).',
    input: z.object({ agentId: AgentId, nonce: z.string(), signature: z.string().min(1) }),
    output: z.object({ epoch: z.number().int().positive(), projectId: ProjectId, role: z.enum(['worker', 'leader']) }),
  }),
  proc({
    name: 'leave',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Graceful exit: WIP committed, handoff note written, locks released, tasks back to ready (F10).',
    input: z.object({ reason: z.string().min(1), handoffNote: z.string().optional() }),
    output: pending,
  }),

  // ── Messages and activity ───────────────────────────────────────────────────────────────
  proc({
    name: 'send',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Send a message to all, a channel, or agent ids. The hub stamps sender and role.',
    input: z.object({
      to: Recipients,
      type: MessageType.exclude(['human', 'control']),
      body: z.string().min(1),
      priority: Priority.exclude(['human']).default('normal'),
      ref: z.string().optional(),
      quotesHumanMessage: z.string().optional(),
    }),
    output: pending,
  }),
  proc({
    name: 'wait',
    kind: 'query',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Long-poll for deliveries, human and control first. Capped below the client timeout (ADR-0001).',
    input: z.object({
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      filter: z.object({ types: z.array(MessageType).optional(), taskId: TaskId.optional() }).optional(),
      // Filled in by rt-agent: delivery rows handed to the model on the previous call.
      ack: z.array(z.number().int()).default([]),
    }),
    output: pending,
  }),
  proc({
    name: 'activity',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Report what you are doing now and next. At least every 5 min and on every task switch.',
    input: z.object({
      doing: z.string().min(1),
      next: z.string().min(1),
      taskId: TaskId.optional(),
      etaMinutes: z.number().int().nonnegative().optional(),
      handoffNote: z.string().optional(),
      tokensUsed: z.number().int().nonnegative().optional(),
    }),
    output: pending,
  }),
  proc({
    name: 'log_action',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Report an action the hub cannot see (shell, file edits, other tools). Also fed by the hook adapter.',
    input: z.object({
      kind: z.string().min(1),
      summary: z.string().min(1),
      refs: z.array(z.string()).default([]),
      source: z.enum(['agent', 'client-hook']).default('agent'),
    }),
    output: pending,
  }),

  // ── Board API ───────────────────────────────────────────────────────────────────────────
  proc({
    name: 'board_view',
    kind: 'query',
    allow: [...AGENTS, 'human'],
    stream: 'project',
    mcp: true,
    summary: 'A prepared view: me, overview or onboarding. Size-capped.',
    input: z.object({ view: z.enum(['me', 'overview', 'onboarding']), projectId: ProjectId.optional() }),
    output: pending,
  }),
  proc({
    name: 'board_read',
    kind: 'query',
    allow: [...AGENTS, 'human'],
    stream: 'project',
    mcp: true,
    summary: 'Structured records of one section, filtered and paged.',
    input: z.object({
      section: Section,
      filter: z.record(z.string(), z.unknown()).optional(),
      fields: z.array(z.string()).optional(),
      sinceSeq: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(200).default(50),
      projectId: ProjectId.optional(),
    }),
    output: pending,
  }),
  proc({
    name: 'board_get',
    kind: 'query',
    allow: [...AGENTS, 'human'],
    stream: 'project',
    mcp: true,
    summary: 'One entry or record by id.',
    input: z.object({ id: z.string().min(1), projectId: ProjectId.optional() }),
    output: pending,
  }),
  proc({
    name: 'board_history',
    kind: 'query',
    allow: [...AGENTS, 'human'],
    stream: 'project',
    mcp: true,
    summary: 'All versions of one entry.',
    input: z.object({ id: z.string().min(1), projectId: ProjectId.optional() }),
    output: pending,
  }),
  proc({
    name: 'board_search',
    kind: 'query',
    allow: [...AGENTS, 'human'],
    stream: 'project',
    mcp: true,
    summary: 'Full-text search across sections.',
    input: z.object({ text: z.string().min(1), sections: z.array(Section).optional(), projectId: ProjectId.optional() }),
    output: pending,
  }),
  proc({
    name: 'board_propose',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Propose a board change. Returns a ticket; the registry routes it to the hub or the leader.',
    input: z.object({
      section: Section,
      op: z.enum(['add', 'update', 'supersede', 'open', 'close']),
      data: z.unknown(),
      /** boardVersion the proposer read; rt-agent fills it from the last board read when omitted (D5). */
      baseSeq: z.number().int().nonnegative().optional(),
      reason: z.string().min(1),
      targetId: z.string().optional(),
      quotesHumanMessage: z.string().optional(),
    }),
    output: z.union([
      z.object({ routedTo: z.literal('leader'), ticketId: TicketId }),
      z.object({ routedTo: z.literal('hub'), committed: z.literal(true), id: z.string() }),
    ]),
  }),
  proc({
    name: 'board_subscribe',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: 'Subscribe to sections, ids, file paths or tags; matching changes arrive through wait (D2).',
    input: z.object({
      sections: z.array(Section).default([]),
      ids: z.array(z.string()).default([]),
      paths: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
    }),
    output: pending,
  }),
  proc({
    name: 'raise_criticality',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: "Raise an entry's criticality, with a reason (D10). Only the human can lower it.",
    input: z.object({ entryId: z.string().min(1), reason: z.string().min(1) }),
    output: pending,
  }),

  // ── Coordination ────────────────────────────────────────────────────────────────────────
  proc({
    name: 'claim',
    kind: 'command',
    allow: ['worker'],
    stream: 'project',
    mcp: true,
    summary: 'Take a ready task. Atomic: first claim wins, the second gets already_claimed + owner.',
    input: z.object({ taskId: TaskId }),
    output: pending,
  }),
  proc({
    name: 'release',
    kind: 'command',
    allow: ['worker'],
    stream: 'project',
    mcp: true,
    summary: 'Give a task back, with a handoff note.',
    input: z.object({ taskId: TaskId, reason: z.string().min(1), handoffNote: z.string().optional() }),
    output: pending,
  }),
  proc({
    name: 'lock',
    kind: 'command',
    allow: ['worker'],
    stream: 'repo',
    mcp: true,
    summary: 'Soft-lock files or modules in the repo. On conflict returns the holder and its project.',
    input: z.object({ paths: Paths, reason: z.string().min(1), taskId: TaskId.optional() }),
    output: pending,
  }),
  proc({
    name: 'unlock',
    kind: 'command',
    allow: ['worker'],
    stream: 'repo',
    mcp: true,
    summary: 'Release locks you hold.',
    input: z.object({ paths: Paths }),
    output: pending,
  }),
  proc({
    name: 'request',
    kind: 'command',
    allow: ['worker'],
    stream: 'project',
    mcp: true,
    summary: 'Ask for review, test, info or notify-on-done. Creates a tracked request.',
    input: z.object({
      to: z.union([z.literal('all'), AgentId]),
      kind: z.enum(['review', 'test', 'info', 'notify_on_done']),
      ref: z.string().min(1),
      body: z.string().optional(),
      /** notify_on_done: the task state that triggers the notification. */
      untilState: z.string().optional(),
    }),
    output: z.object({ requestId: RequestId }),
  }),
  proc({
    name: 'respond',
    kind: 'command',
    allow: ['worker'],
    stream: 'project',
    mcp: true,
    summary: 'Close a request. Review and test results must name the head sha they are about (ADR-0008).',
    input: z.object({
      requestId: RequestId,
      result: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('review'), verdict: z.enum(['approved', 'changes_needed']), headSha: Sha, notes: z.string().default('') }),
        z.object({ kind: z.literal('test'), status: z.enum(['pass', 'fail']), headSha: Sha, evidence: z.string().min(1) }),
        z.object({ kind: z.literal('info'), answer: z.string().min(1) }),
        z.object({ kind: z.literal('declined'), reason: z.string().min(1) }),
        z.object({ kind: z.literal('done'), note: z.string().default('') }),
      ]),
    }),
    output: pending,
  }),
  proc({
    name: 'ask_human',
    kind: 'command',
    allow: AGENTS,
    stream: 'project',
    mcp: true,
    summary: "Escalate to the human. A blocking question pauses only the asker's task.",
    input: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      defaultOption: z.string().optional(),
      risk: z.enum(['low', 'high']).default('high'),
      blocking: z.boolean(),
      taskId: TaskId.optional(),
    }),
    output: pending,
  }),
  proc({
    name: 'vote',
    kind: 'command',
    allow: ['worker'],
    stream: 'project',
    mcp: true,
    summary: 'Vote on an open proposal. An object must include a reason and an alternative.',
    input: z.object({
      voteId: VoteId,
      choice: z.enum(['yes', 'no', 'object']),
      reason: z.string().optional(),
      alternative: z.string().optional(),
      blocking: z.boolean().default(false),
    }),
    output: pending,
  }),

  // ── Leader only ─────────────────────────────────────────────────────────────────────────
  proc({
    name: 'board_commit',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: "Commit a ticket. The hub checks base_seq (D5) and the section's leader requirement.",
    input: z.object({ ticketId: TicketId, evidence: z.array(z.string()).default([]) }),
    output: pending,
  }),
  proc({
    name: 'board_reject',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: 'Reject a ticket with a reason; the proposer is told.',
    input: z.object({ ticketId: TicketId, reason: z.string().min(1) }),
    output: pending,
  }),
  proc({
    name: 'broadcast_critical',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: 'Critical alert to the agents a change affects; they must acknowledge (F7).',
    input: z.object({ body: z.string().min(1), affected: z.array(AgentId).min(1), ref: z.string().optional() }),
    output: pending,
  }),
  proc({
    name: 'open_vote',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: 'Open a team vote on a proposal, with a window.',
    input: z.object({ ticketId: TicketId, windowMs: z.number().int().positive().optional(), explicitMajority: z.boolean().default(false) }),
    output: z.object({ voteId: VoteId }),
  }),
  proc({
    name: 'summarize',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: 'Post a digest entry summarizing recent changes.',
    input: z.object({ body: z.string().min(1), sinceSeq: z.number().int().nonnegative() }),
    output: pending,
  }),
  proc({
    name: 'dismiss',
    kind: 'command',
    allow: ['leader'],
    stream: 'project',
    mcp: true,
    summary: 'Tell an agent its work is done and it may stop looping (D3).',
    input: z.object({ agentId: AgentId, reason: z.string().min(1) }),
    output: pending,
  }),
  proc({
    name: 'history_search',
    kind: 'query',
    allow: ['leader', 'human'],
    stream: 'system',
    mcp: true,
    summary: "Search other projects' knowledge, decisions and retros (never their messages).",
    input: z.object({ query: z.string().min(1), projects: z.array(ProjectId).optional() }),
    output: pending,
  }),
  proc({
    name: 'history_get',
    kind: 'query',
    allow: ['leader', 'human'],
    stream: 'system',
    mcp: true,
    summary: "Read one past project's durable board sections.",
    input: z.object({ projectId: ProjectId, section: Section.optional() }),
    output: pending,
  }),

  // ── Human app only (never MCP) ──────────────────────────────────────────────────────────
  proc({ name: 'project.create', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Create a project: blank, from a template, or copying rules and roles.', input: z.object({ name: z.string().min(1), copyFrom: ProjectId.optional() }), output: z.object({ projectId: ProjectId }) }),
  proc({ name: 'project.list', kind: 'query', allow: ['human'], stream: 'system', mcp: false, summary: 'All projects with status, for the sidebar.', input: z.object({}), output: pending }),
  proc({ name: 'pairing.list', kind: 'query', allow: ['human'], stream: 'system', mcp: false, summary: 'Pending join requests and paired agents.', input: z.object({}), output: pending }),
  proc({ name: 'repo.attach', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Attach a local git repository to a project (spec: access). The hub merges into its main branch.', input: z.object({ projectId: ProjectId, path: z.string().min(1), mainBranch: z.string().min(1).default('main') }), output: pending }),
  proc({ name: 'project.archive', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Archive a project.', input: z.object({ projectId: ProjectId }), output: pending }),
  proc({ name: 'project.delete', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Delete a project.', input: z.object({ projectId: ProjectId }), output: pending }),
  proc({ name: 'project.pin', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Pin or unpin a project in the sidebar.', input: z.object({ projectId: ProjectId, pinned: z.boolean() }), output: pending }),
  proc({ name: 'goal.set', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Set or change the goal (a new version supersedes the old).', input: inProject({ goal: z.unknown() }), output: pending }),
  proc({ name: 'rules.edit', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Edit working rules, including test_command.', input: inProject({ rules: z.unknown() }), output: pending }),
  proc({ name: 'plan.approve', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Approve the plan (optionally edited); tasks move to ready and roll call starts.', input: inProject({ planEntryId: z.string().optional(), edits: z.unknown().optional() }), output: pending }),
  proc({ name: 'plan.reject', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Send the plan back with notes.', input: inProject({ planEntryId: z.string(), notes: z.string().min(1) }), output: pending }),
  proc({ name: 'inbox.answer', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Answer a question or approval in human_inbox.', input: inProject({ itemId: z.string(), answer: z.string().min(1) }), output: pending }),
  proc({ name: 'decision.override', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Override a decision; the old one is marked superseded.', input: inProject({ decisionId: z.string(), decision: z.unknown() }), output: pending }),
  proc({ name: 'criticality.lower', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Lower a critical entry (human only, D10).', input: inProject({ entryId: z.string(), reason: z.string().min(1) }), output: pending }),
  proc({ name: 'access.grant', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Grant access (references only, never secret values).', input: inProject({ agentIds: z.array(AgentId), reference: z.string().min(1), note: z.string().optional() }), output: pending }),
  proc({ name: 'access.revoke', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Revoke granted access.', input: inProject({ accessEntryId: z.string() }), output: pending }),
  proc({ name: 'control.pause', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Pause an agent, a project, or everything.', input: z.object({ scope: z.enum(['agent', 'project', 'all']), projectId: ProjectId.optional(), agentId: AgentId.optional() }), output: pending }),
  proc({ name: 'control.resume', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Resume an agent, a project, or everything.', input: z.object({ scope: z.enum(['agent', 'project', 'all']), projectId: ProjectId.optional(), agentId: AgentId.optional() }), output: pending }),
  proc({ name: 'control.stop', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Stop an agent, a project, or everything.', input: z.object({ scope: z.enum(['agent', 'project', 'all']), projectId: ProjectId.optional(), agentId: AgentId.optional() }), output: pending }),
  proc({ name: 'pairing.allow', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Allow a join request into a project; returns the one-time code.', input: z.object({ requestId: PairingId, projectId: ProjectId.optional(), newProjectName: z.string().optional() }), output: z.object({ code: z.string().length(8), expiresAt: z.number().int() }) }),
  proc({ name: 'pairing.deny', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Deny a join request.', input: z.object({ requestId: PairingId }), output: pending }),
  proc({ name: 'pairing.block_origin', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Block a network origin from pairing.', input: z.object({ origin: z.string().min(1) }), output: pending }),
  proc({ name: 'pairing.remember', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: "Keep an agent's key across projects.", input: z.object({ agentId: AgentId, remember: z.boolean() }), output: pending }),
  proc({ name: 'leader.assign', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Assign or replace the leader.', input: inProject({ agentId: AgentId }), output: pending }),
  proc({ name: 'agent.remove', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Remove an agent: key revoked, graceful cleanup.', input: inProject({ agentId: AgentId, reason: z.string().min(1) }), output: pending }),
  proc({ name: 'key.revoke', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: "Revoke an agent's key; its next rejoin fails.", input: z.object({ agentId: AgentId }), output: pending }),
  proc({ name: 'key.rotate', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Require a new key: the agent proves the old key, then registers a new one.', input: z.object({ agentId: AgentId }), output: pending }),
  proc({ name: 'human.post', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Composer: instruction to everyone or chosen agents, always at human priority.', input: inProject({ to: Recipients, body: z.string().min(1) }), output: pending }),
  proc({ name: 'leader_chat.send', kind: 'command', allow: ['human'], stream: 'project', mcp: false, summary: 'Direct thread with the leader.', input: inProject({ body: z.string().min(1), kind: z.enum(['question', 'insight']) }), output: pending }),
  proc({ name: 'settings.update', kind: 'command', allow: ['human'], stream: 'system', mcp: false, summary: 'Budgets, timeouts, grace periods, notification and pairing rules (global or per project).', input: z.object({ projectId: ProjectId.optional(), settings: z.record(z.string(), z.unknown()) }), output: pending }),
  proc({ name: 'logs.query', kind: 'query', allow: ['human'], stream: 'project', mcp: false, summary: 'Event log explorer: filter by agent, type, task, time; full-text search.', input: inProject({ filter: z.record(z.string(), z.unknown()).default({}), limit: z.number().int().positive().max(1000).default(200) }), output: pending }),
  proc({ name: 'board.at', kind: 'query', allow: ['human'], stream: 'project', mcp: false, summary: 'The board as it was at a past seq (time travel), from the nearest snapshot plus replay.', input: inProject({ seq: z.number().int().nonnegative() }), output: pending }),
  proc({ name: 'metrics.query', kind: 'query', allow: ['human'], stream: 'project', mcp: false, summary: 'Flow, quality, coordination, human wait, cost and health metrics.', input: inProject({ from: z.number().int(), to: z.number().int() }), output: pending }),
  proc({ name: 'export', kind: 'query', allow: ['human'], stream: 'project', mcp: false, summary: 'Export the raw log (JSON Lines) or board and retro (Markdown).', input: inProject({ format: z.enum(['jsonl', 'markdown']) }), output: pending }),
  proc({ name: 'change_request.get', kind: 'query', allow: ['human', 'worker', 'leader'], stream: 'project', mcp: false, summary: 'One change request with its approvals, test results and hub test runs.', input: z.object({ changeRequestId: ChangeRequestId, projectId: ProjectId.optional() }), output: pending }),
  proc({ name: 'control.ack', kind: 'command', allow: AGENTS, stream: 'project', mcp: false, summary: 'Sent by rt-agent when the model has seen a critical alert or control message (F7).', input: z.object({ messageId: z.string(), action: ControlAction.optional() }), output: pending }),
] as const;

export type ProcedureName = (typeof PROCEDURES)[number]['name'];

const byName = new Map<string, ProcedureDef>(PROCEDURES.map((p) => [p.name, p]));

export function getProcedure(name: string): ProcedureDef | undefined {
  return byName.get(name);
}

/** The MCP tool list an agent with this role should see (ADR-0011: leader tools appear after list_changed). */
export function mcpToolsFor(kind: PrincipalKind): ProcedureDef[] {
  return PROCEDURES.filter((p) => p.mcp && (p.allow as readonly PrincipalKind[]).includes(kind));
}
