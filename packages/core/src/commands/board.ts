import {
  DOCUMENT_DATA,
  getSection,
  TaskProposal,
  type EntryId,
  type PendingEvent,
  type ProjectId,
  type TaskId,
  type TicketId,
} from '@round-table/protocol';
import { z } from 'zod';
import { authorOf, inProject, makeEvent, type Author } from '../event.ts';
import { accept, reject, type Command, type CommandHandler, type Decision } from '../module.ts';
import { settingsFor, type EntryRecord, type Model, type ProjectRecord } from '../model.ts';
import type { Ctx } from '../ports.ts';
import { openOrRefreshChangeRequest } from './changes.ts';
import { displayName, freeWorkers, hubMessage, reachable } from './notify.ts';

/**
 * The board's write path (ADR-0007): agents propose, the registry routes each proposal to the hub
 * or the leader, and only hub rules, leader commits and human actions write entries.
 */

/** Sections with one entry per project: a proposal to change them always targets that entry. */
const SINGLETONS = new Set(['goal', 'rules']);
/** Sections whose leader commits need votes or agreement, which arrive in S3. */
const NEEDS_S3 = new Set(['vote', 'majority_or_human', 'agreement']);

export interface ProposeInput {
  section: string;
  op: string;
  data: unknown;
  baseSeq?: number;
  reason: string;
  targetId?: string;
  quotesHumanMessage?: string;
  /** Prepared by the hub for artifacts: the branch's current head sha (null if the branch does not exist). */
  headSha?: string | null;
}

export const propose: CommandHandler<ProposeInput> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker' && principal.kind !== 'leader') return reject('forbidden', 'agents only');
  const project = model.projects[principal.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const input = command.input;
  const def = getSection(input.section);
  if (!def) return reject('unknown_section', `no section "${input.section}"`);
  if (!def.proposals) {
    return reject('not_proposable', `${input.section} is recorded by the hub or edited by the human; use the dedicated tools (claim, request, activity…)`);
  }
  if (input.section === 'artifacts') return openOrRefreshChangeRequest(model, project, command, ctx);
  if (input.section !== 'tasks' && !DOCUMENT_DATA[input.section]) {
    return reject('not_built', `proposals to ${input.section} arrive in a later slice (see build-plan.md)`);
  }

  const validation = validateProposal(project, input);
  if (!validation.ok) return validation.decision;
  if (input.quotesHumanMessage !== undefined && !project.humanMessages[input.quotesHumanMessage]) {
    return reject('unverified_quote', 'that human message id does not exist in this project');
  }

  const ticketId = ctx.ids.next('ticket') as TicketId;
  const author = authorOf(principal);
  const where = inProject(project.projectId);
  const events: PendingEvent[] = [
    makeEvent(ctx, author, where, 'ticket.opened', {
      ticketId,
      section: input.section,
      op: input.op,
      data: validation.data,
      baseSeq: input.baseSeq ?? project.boardVersion,
      reason: input.reason,
      targetId: validation.targetId,
      proposer: principal.agentId,
      quotesHumanMessage: input.quotesHumanMessage ?? null,
    }, { refs: { ticket: [ticketId] }, reason: input.reason }),
    ...hubMessage(ctx, project.projectId, [project.leaderId], {
      priority: 'direct',
      type: 'proposal',
      ref: ticketId,
      body: `${displayName(project, principal.agentId)} proposes ${input.op} on ${input.section}: ${input.reason}. Review it (board_get ${ticketId}), then board_commit or board_reject.`,
    }),
  ];
  const waiting = project.leaderId ? '' : ' No leader is assigned yet; the ticket waits until the human assigns one.';
  return accept(events, { routedTo: 'leader', ticketId, note: `Sent to the leader for commit.${waiting}` });
};

function validateProposal(
  project: ProjectRecord,
  input: ProposeInput,
): { ok: true; data: unknown; targetId: string | null } | { ok: false; decision: Decision } {
  const fail = (code: string, message: string, details?: Record<string, unknown>) => ({ ok: false as const, decision: reject(code, message, details) });
  if (input.section === 'tasks') {
    if (input.op !== 'add') return fail('invalid_op', 'tasks accept only op "add"; state changes use claim, release and the review flow');
    const parsed = TaskProposal.safeParse(input.data);
    if (!parsed.success) return fail('invalid_data', z.prettifyError(parsed.error));
    for (const dep of parsed.data.deps) {
      const ticket = project.tickets[dep as TicketId];
      if (!project.tasks[dep as TaskId] && !(ticket?.section === 'tasks' && ticket.status !== 'rejected')) return fail('unknown_task', `dependency ${dep} is neither a task nor a proposed task`);
    }
    return { ok: true, data: parsed.data, targetId: null };
  }
  if (!['add', 'update', 'supersede'].includes(input.op)) return fail('invalid_op', 'documents accept op "add", "update" or "supersede"');
  const parsed = DOCUMENT_DATA[input.section]!.safeParse(input.data);
  if (!parsed.success) return fail('invalid_data', z.prettifyError(parsed.error));
  let targetId = input.targetId ?? null;
  if (SINGLETONS.has(input.section)) {
    targetId = singleton(project, input.section)?.entryId ?? null;
  } else if (input.op !== 'add') {
    if (!targetId) return fail('invalid_input', `op "${input.op}" needs targetId`);
    const target = project.entries[targetId as EntryId];
    if (!target || target.section !== input.section) return fail('unknown_entry', `no ${input.section} entry ${targetId}`);
  }
  if (targetId !== null && input.baseSeq === undefined) return fail('base_seq_required', 'changing an entry needs baseSeq: the boardVersion you read it at');
  return { ok: true, data: parsed.data, targetId };
}

export function singleton(project: ProjectRecord, section: string): EntryRecord | undefined {
  return Object.values(project.entries).find((e) => e.section === section);
}

/** A new version of an entry (or a new entry). The single write path for document sections. */
export function versionEntry(
  ctx: Ctx,
  author: Author,
  project: ProjectRecord,
  section: string,
  data: unknown,
  options: { targetId: string | null; ticketId: TicketId | null; urgent?: boolean; authorId: string },
): { event: PendingEvent; entryId: EntryId } {
  const previous = options.targetId ? project.entries[options.targetId as EntryId] : undefined;
  const entryId = (previous?.entryId ?? ctx.ids.next('entry')) as EntryId;
  const version = (previous?.version ?? 0) + 1;
  const def = getSection(section);
  const criticality = def?.notify.priority === 'critical' || options.urgent ? 'critical' : 'normal';
  const event = makeEvent(
    ctx,
    author,
    inProject(project.projectId),
    'entry.versioned',
    {
      entryId,
      section,
      version,
      supersedes: previous ? `${previous.entryId}@${previous.version}` : null,
      author: options.authorId,
      data,
      tags: [],
      criticality,
      ticketId: options.ticketId,
      refs: options.ticketId ? { ticket: [options.ticketId] } : {},
    },
    { refs: { entry: [entryId], ...(options.ticketId && { ticket: [options.ticketId] }) } },
  );
  return { event, entryId };
}

/** Notify rule per section (registry `notify`), for the audiences S2 can resolve. */
function sectionNotice(ctx: Ctx, project: ProjectRecord, section: string, summary: string, ref: string, urgent = false): PendingEvent[] {
  const def = getSection(section);
  if (!def) return [];
  // "Affected" agents aren't resolved yet (S3): everyone gets it, but as a normal FYI that rides
  // along with their next turn instead of waking the whole team.
  const affectedOnly = def.notify.audience.includes('affected') && !def.notify.audience.includes('everyone');
  const priority = urgent ? 'critical' : affectedOnly ? 'normal' : def.notify.priority;
  const everyone = def.notify.audience.includes('everyone') || def.notify.audience.includes('affected');
  const to = everyone ? reachable(project) : def.notify.audience.includes('leader') ? [project.leaderId] : [];
  return hubMessage(ctx, project.projectId, to, { priority, type: 'alert', body: summary, ref });
}

/**
 * The leader commits one ticket, or a whole plan at once (`ticketIds`): one turn instead of one per
 * task. Tasks in the batch may depend on each other by ticket id.
 */
export const commit: CommandHandler<{ ticketId?: TicketId; ticketIds?: TicketId[]; evidence: string[] }> = (model, command, ctx) => {
  const ids = [...new Set([...(command.input.ticketIds ?? []), ...(command.input.ticketId ? [command.input.ticketId] : [])])];
  if (ids.length === 0) return reject('invalid_input', 'give ticketId or ticketIds');
  if (ids.length === 1) return withAutoApproval(model, command, ctx, commitOne(model, command, ctx, ids[0]!, new Map()));
  const made = new Map<string, string>();
  const events: PendingEvent[] = [];
  const committed: Array<{ ticketId: string; result: string }> = [];
  const rejected: Array<{ ticketId: string; code: string; message: string }> = [];
  // Order so a task comes after the tickets it depends on.
  const pending = [...ids];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (const id of [...pending]) {
      const deps = ((model.projects[(command.principal as { projectId: ProjectId }).projectId]?.tickets[id]?.data as { deps?: string[] } | undefined)?.deps ?? []);
      if (deps.some((d) => pending.includes(d as TicketId) && d !== id)) continue;
      pending.splice(pending.indexOf(id), 1);
      progress = true;
      const decision = commitOne(model, command, ctx, id, made);
      events.push(...decision.events);
      if (decision.ok) {
        const result = (decision.output as { committed: string }).committed;
        made.set(id, result);
        committed.push({ ticketId: id, result });
      } else rejected.push({ ticketId: id, code: decision.rejection.code, message: decision.rejection.message });
    }
  }
  for (const id of pending) rejected.push({ ticketId: id, code: 'dependency_cycle', message: 'its dependencies form a cycle' });
  if (committed.length === 0) return reject(rejected[0]!.code, rejected[0]!.message, { rejected }, events);
  return withAutoApproval(model, command, ctx, accept(events, { committed, rejected }));
};

/**
 * Full auto (settings: plan approval by the leader, ADR-0020): the leader's commit is the approval,
 * so its new tasks are ready at once and the free workers are told to claim them.
 */
function withAutoApproval(model: Readonly<Model>, command: Command, ctx: Ctx, decision: Decision): Decision {
  if (!decision.ok || command.principal.kind !== 'leader') return decision;
  const project = model.projects[command.principal.projectId];
  if (!project || settingsFor(model, project.projectId).autonomy.planApproval !== 'leader') return decision;
  const created = decision.events.filter((e) => e.type === 'task.created').map((e) => e.payload as { taskId: TaskId });
  if (created.length === 0) return decision;
  const author = { ...authorOf(command.principal), via: 'leader' as const };
  const where = inProject(project.projectId);
  const ready = created.map((t) => makeEvent(ctx, author, where, 'task.status_changed', { taskId: t.taskId, from: 'proposed', to: 'ready', cause: 'leader', reason: 'plan approved by the leader (full auto)' }, { refs: { task: [t.taskId] } }));
  const notice = hubMessage(ctx, project.projectId, freeWorkers(project), {
    priority: 'direct',
    type: 'alert',
    body: `The leader approved the plan: ${created.length} task${created.length === 1 ? ' is' : 's are'} ready. Claim one that fits you (board_read "tasks", then claim).`,
  });
  return { ...decision, events: [...decision.events, ...ready, ...notice] };
}

function commitOne(model: Readonly<Model>, command: Command<{ evidence: string[] }>, ctx: Ctx, ticketId: TicketId, made: ReadonlyMap<string, string>): Decision {
  const principal = command.principal;
  if (principal.kind !== 'leader') return reject('forbidden', 'leader only');
  const project = model.projects[principal.projectId];
  const ticket = project?.tickets[ticketId];
  if (!project || !ticket) return reject('unknown_ticket', 'no such ticket');
  if (ticket.status !== 'open') return reject('ticket_closed', `ticket is already ${ticket.status}`);
  const author = authorOf(principal);
  const where = inProject(project.projectId);
  const leaderAuthor: Author = { ...author, via: 'leader' };

  const requirement = getSection(ticket.section)?.leaderRequires ?? 'none';
  if (requirement === 'human_quote' && !(ticket.quotesHumanMessage && project.humanMessages[ticket.quotesHumanMessage])) {
    return reject('needs_human_quote', `${ticket.section} changes must quote a verified human message (quotesHumanMessage); otherwise the human edits it in the app`);
  }
  if (NEEDS_S3.has(requirement)) {
    return reject('needs_vote', `${ticket.section} changes need a team vote or agreement, which arrive in S3; for now the human edits ${ticket.section} in the app`);
  }

  // D5: the target changed after the proposer read it; send it back to be redone.
  const target = ticket.targetId ? project.entries[ticket.targetId as EntryId] : undefined;
  if (target && target.changedAt > ticket.baseSeq) {
    const events = [
      makeEvent(ctx, author, where, 'ticket.rejected', { ticketId: ticket.ticketId, by: principal.agentId, reason: 'stale: the entry changed after the proposal was made', stale: true }),
      ...hubMessage(ctx, project.projectId, [ticket.proposer], {
        priority: 'direct',
        type: 'response',
        ref: ticket.ticketId,
        body: `Your proposal ${ticket.ticketId} on ${ticket.section} is stale: the entry changed since you read it. Read it again and propose again.`,
      }),
    ];
    return reject('stale_base', 'the target changed after this proposal was made; the proposer was asked to redo it', { entryId: target.entryId }, events);
  }

  const events: PendingEvent[] = [];
  let result: string;
  let summary: string;
  if (ticket.section === 'tasks') {
    const task = ticket.data as TaskProposal;
    const taskId = ctx.ids.next('task') as TaskId;
    events.push(
      makeEvent(ctx, leaderAuthor, where, 'task.created', {
        taskId,
        title: task.title,
        criteria: task.criteria,
        reviewer: task.reviewer ?? null,
        tester: task.tester ?? null,
        // A dep given as a ticket id becomes the task that ticket was committed as.
        deps: task.deps.map((d) => (made.get(d) ?? project.tickets[d as TicketId]?.result ?? d) as TaskId).filter((d) => d.startsWith('tsk_')),
        capabilities: task.capabilities,
        ticketId: ticket.ticketId,
        proposer: ticket.proposer,
      }, { refs: { task: [taskId], ticket: [ticket.ticketId] } }),
    );
    result = taskId;
    summary = '';
  } else {
    const urgent = ticket.section === 'knowledge' && (ticket.data as { urgent?: boolean }).urgent === true;
    const { event, entryId } = versionEntry(ctx, leaderAuthor, project, ticket.section, ticket.data, {
      targetId: ticket.targetId,
      ticketId: ticket.ticketId,
      urgent,
      authorId: ticket.proposer,
    });
    events.push(event);
    result = entryId;
    summary = `${ticket.section} ${ticket.targetId ? 'updated' : 'added'} (${entryId}): ${ticket.reason}`;
    events.push(...sectionNotice(ctx, project, ticket.section, summary, entryId, urgent));
  }
  events.push(
    makeEvent(ctx, author, where, 'ticket.committed', { ticketId: ticket.ticketId, by: principal.agentId, result }),
    ...(ticket.proposer === principal.agentId
      ? []
      // An FYI: nothing to do, so it rides along with the proposer's next turn.
      : hubMessage(ctx, project.projectId, [ticket.proposer], { priority: 'normal', type: 'response', ref: ticket.ticketId, body: `Your proposal ${ticket.ticketId} was committed as ${result}.` })),
  );
  return accept(events, { committed: result });
}

export const rejectTicket: CommandHandler<{ ticketId: TicketId; reason: string }> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'leader') return reject('forbidden', 'leader only');
  const project = model.projects[principal.projectId];
  const ticket = project?.tickets[command.input.ticketId];
  if (!project || !ticket) return reject('unknown_ticket', 'no such ticket');
  if (ticket.status !== 'open') return reject('ticket_closed', `ticket is already ${ticket.status}`);
  return accept([
    makeEvent(ctx, authorOf(principal), inProject(project.projectId), 'ticket.rejected', { ticketId: ticket.ticketId, by: principal.agentId, reason: command.input.reason, stale: false }),
    ...hubMessage(ctx, project.projectId, [ticket.proposer], {
      priority: 'normal',
      type: 'response',
      ref: ticket.ticketId,
      body: `The leader rejected your proposal ${ticket.ticketId}: ${command.input.reason}`,
    }),
  ]);
};

/** Human edits of singleton documents (goal.set, rules.edit): written directly, via human. */
export function humanEdit(section: 'goal' | 'rules', field: 'goal' | 'rules'): CommandHandler<{ projectId: ProjectId } & Record<string, unknown>> {
  return (model, command, ctx) => {
    if (command.principal.kind !== 'human') return reject('forbidden', 'human only');
    const project = model.projects[command.input.projectId];
    if (!project) return reject('unknown_project', 'no such project');
    const parsed = DOCUMENT_DATA[section]!.safeParse(command.input[field]);
    if (!parsed.success) return reject('invalid_data', z.prettifyError(parsed.error));
    const existing = singleton(project, section);
    const { event, entryId } = versionEntry(ctx, authorOf(command.principal), project, section, parsed.data, {
      targetId: existing?.entryId ?? null,
      ticketId: null,
      authorId: 'human',
    });
    const summary = section === 'goal'
      ? `The human ${existing ? 'changed' : 'set'} the goal: ${(parsed.data as { objective: string }).objective}`
      : 'The human updated the working rules. Read them with board_read("rules").';
    return accept([event, ...sectionNotice(ctx, project, section, summary, entryId)], { entryId });
  };
}

