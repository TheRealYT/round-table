import {
  EVENT_DURABILITY,
  type EventPayloads,
  type EventType,
  type PendingEvent,
  type Principal,
  type ProjectId,
  type Refs,
  type Role,
  type StreamId,
  type Via,
} from '@round-table/protocol';
import type { Ctx } from './ports.ts';

export interface Author {
  actor: string;
  role: Role;
  via: Via;
}

/** Who an event is attributed to, from the caller. The hub stamps this; senders cannot choose it. */
export function authorOf(principal: Principal): Author {
  switch (principal.kind) {
    case 'worker':
    case 'leader':
      return { actor: principal.agentId, role: principal.kind, via: 'hub' };
    case 'human':
      return { actor: `human:${principal.humanId}`, role: 'human', via: 'human' };
    case 'hub':
      return { actor: 'hub', role: 'hub', via: 'hub' };
    case 'unpaired':
      return { actor: 'hub', role: 'hub', via: 'hub' };
  }
}

export const HUB: Author = { actor: 'hub', role: 'hub', via: 'hub' };

export function projectStream(projectId: ProjectId): StreamId {
  return `project:${projectId}`;
}

/** Builds a pending event with the catalog's durability and ctx time. */
export function makeEvent<T extends EventType>(
  ctx: Ctx,
  author: Author,
  target: { stream: StreamId; projectId: ProjectId | null },
  type: T,
  payload: EventPayloads[T],
  extra: { refs?: Refs; reason?: string | null } = {},
): PendingEvent {
  return {
    stream: target.stream,
    projectId: target.projectId,
    type,
    actor: author.actor,
    role: author.role,
    via: author.via,
    ts: ctx.now,
    refs: extra.refs ?? {},
    payload,
    reason: extra.reason ?? null,
    durability: EVENT_DURABILITY[type],
  };
}

export const SYSTEM = { stream: 'system', projectId: null } as const;

export function inProject(projectId: ProjectId): { stream: StreamId; projectId: ProjectId } {
  return { stream: projectStream(projectId), projectId };
}

/** Narrows an event to its catalog payload type. */
export function payloadOf<T extends EventType>(event: PendingEvent, type: T): EventPayloads[T] | undefined {
  return event.type === type ? (event.payload as EventPayloads[T]) : undefined;
}
