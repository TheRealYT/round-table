import { priorityRank, type AgentId, type MessagePayload, type MessageType, type Priority, type ProjectId } from '@round-table/protocol';
import { authorOf, inProject, makeEvent } from '../event.ts';
import { accept, reject, type CommandHandler, type Decision } from '../module.ts';
import type { ProjectRecord } from '../model.ts';
import { startedWork } from './tasks.ts';

type To = 'all' | string | string[];

/** Agents a message reaches: everyone reachable on the roster except the sender. Unknown ids are an error. */
function resolveRecipients(project: ProjectRecord, to: To, sender: string | null): { ok: true; ids: AgentId[] } | { ok: false; unknown: string[] } {
  const reachable = Object.values(project.roster).filter((e) => e.state === 'active' || e.state === 'stale');
  if (Array.isArray(to)) {
    const unknown = to.filter((id) => !reachable.some((e) => e.agentId === id));
    if (unknown.length > 0) return { ok: false, unknown };
    return { ok: true, ids: to.filter((id) => id !== sender) as AgentId[] };
  }
  // 'all' or a channel name: channels are not modeled yet, so a channel reaches everyone.
  return { ok: true, ids: reachable.map((e) => e.agentId).filter((id) => id !== sender) };
}

export const send: CommandHandler<{
  to: To;
  type: MessageType;
  body: string;
  priority: Priority;
  ref?: string;
  quotesHumanMessage?: string;
}> = (model, command, ctx): Decision => {
  const principal = command.principal;
  if (principal.kind !== 'worker' && principal.kind !== 'leader') return reject('forbidden', 'agents only');
  const project = model.projects[principal.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const { to, type, body, ref, quotesHumanMessage } = command.input;
  // Only the leader (or the hub) sends critical (spec: Priority levels).
  if (command.input.priority === 'critical' && principal.kind !== 'leader') {
    return reject('forbidden_priority', 'only the leader can send critical messages');
  }
  if (quotesHumanMessage !== undefined && !project.humanMessages[quotesHumanMessage]) {
    return reject('unverified_quote', 'that human message id does not exist in this project');
  }
  const recipients = resolveRecipients(project, to, principal.agentId);
  if (!recipients.ok) return reject('unknown_recipient', 'some recipients are not on the roster', { unknown: recipients.unknown });
  // A message addressed to specific agents is at least `direct` for them. A worker's message to
  // everyone is `normal` at most: it reaches everyone with their next turn but wakes nobody, so one
  // status update doesn't cost a turn per agent. The leader keeps its priority (critical alerts).
  const broadcast = !Array.isArray(to);
  const priority: Priority = !broadcast && priorityRank(command.input.priority) > priorityRank('direct')
    ? 'direct'
    : broadcast && principal.kind === 'worker' && priorityRank(command.input.priority) < priorityRank('normal')
      ? 'normal'
      : command.input.priority;
  const messageId = ctx.ids.next('message');
  const payload: MessagePayload = {
    messageId,
    from: principal.agentId,
    role: principal.kind,
    to,
    channel: typeof to === 'string' && to !== 'all' ? to : null,
    type,
    priority,
    ref: ref ?? null,
    body,
    recipients: recipients.ids,
    quotesHumanMessage: quotesHumanMessage ?? null,
  };
  return accept([makeEvent(ctx, authorOf(principal), inProject(project.projectId), 'message.sent', payload, { refs: { message: [messageId] } })], {
    messageId,
    delivered: recipients.ids.length,
  });
};

export const humanPost: CommandHandler<{ projectId: ProjectId; to: To; body: string }> = (model, command, ctx) => {
  if (command.principal.kind !== 'human') return reject('forbidden', 'human only');
  const project = model.projects[command.input.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const recipients = resolveRecipients(project, command.input.to, null);
  if (!recipients.ok) return reject('unknown_recipient', 'some recipients are not on the roster', { unknown: recipients.unknown });
  const messageId = ctx.ids.next('message');
  const author = authorOf(command.principal);
  const payload: MessagePayload = {
    messageId,
    from: author.actor,
    role: 'human',
    to: command.input.to,
    channel: null,
    type: 'human',
    priority: 'human',
    ref: null,
    body: command.input.body,
    recipients: recipients.ids,
    quotesHumanMessage: null,
  };
  return accept([makeEvent(ctx, author, inProject(project.projectId), 'human.posted', payload, { refs: { message: [messageId] } })], {
    messageId,
    delivered: recipients.ids.length,
  });
};

export const reportActivity: CommandHandler<{
  doing: string;
  next: string;
  taskId?: string;
  etaMinutes?: number;
  handoffNote?: string;
}> = (model, command, ctx) => {
  const principal = command.principal;
  if (principal.kind !== 'worker' && principal.kind !== 'leader') return reject('forbidden', 'agents only');
  const project = model.projects[principal.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const { doing, next, taskId, etaMinutes, handoffNote } = command.input;
  return accept([
    ...startedWork(ctx, project, principal.agentId, taskId),
    makeEvent(ctx, authorOf(principal), inProject(principal.projectId), 'activity.reported', {
      agentId: principal.agentId,
      doing,
      next,
      taskId: taskId ?? null,
      etaMinutes: etaMinutes ?? null,
      handoffNote: handoffNote ?? null,
    }),
  ]);
};
