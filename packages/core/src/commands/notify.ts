import type { AgentId, MessagePayload, MessageType, PendingEvent, Priority, ProjectId } from '@round-table/protocol';
import { HUB, inProject, makeEvent } from '../event.ts';
import type { ProjectRecord } from '../model.ts';
import type { Ctx } from '../ports.ts';

/** Agents that can receive messages: active or stale (still within grace). */
export function reachable(project: ProjectRecord): AgentId[] {
  return Object.values(project.roster)
    .filter((e) => e.state === 'active' || e.state === 'stale')
    .map((e) => e.agentId);
}

export function displayName(project: ProjectRecord, id: string): string {
  return project.roster[id as AgentId]?.name ?? id;
}

/**
 * A message from the hub itself (role `hub`): ticket routing, review requests, merge results.
 * It uses the normal delivery path, so it reaches `wait`, the status line and the feed.
 */
export function hubMessage(
  ctx: Ctx,
  projectId: ProjectId,
  to: readonly (AgentId | null | undefined)[],
  message: { priority: Priority; type: MessageType; body: string; ref?: string | null },
): PendingEvent[] {
  const recipients = [...new Set(to.filter((id): id is AgentId => typeof id === 'string'))];
  if (recipients.length === 0) return [];
  const payload: MessagePayload = {
    messageId: ctx.ids.next('message'),
    from: 'hub',
    role: 'hub',
    to: recipients,
    channel: null,
    type: message.type,
    priority: message.priority,
    ref: message.ref ?? null,
    body: message.body,
    recipients,
    quotesHumanMessage: null,
  };
  return [makeEvent(ctx, HUB, inProject(projectId), 'message.sent', payload, { refs: { message: [payload.messageId] } })];
}
