import type { PendingEvent, StreamId, ProjectId } from '@round-table/protocol';
import { HUB, makeEvent } from '../event.ts';
import type { Model } from '../model.ts';
import type { Ctx } from '../ports.ts';

type Target = { stream: StreamId; projectId: ProjectId | null };

/** Schedules an internal command (principal: hub) to run at `dueAt` (ADR-0010). */
export function schedule(ctx: Ctx, target: Target, dueAt: number, name: string, input: Record<string, unknown>): PendingEvent {
  return makeEvent(ctx, HUB, target, 'timer.scheduled', { timerId: ctx.ids.next('timer'), dueAt, command: { name, input } });
}

/** Cancels every pending timer whose command matches. */
export function cancelTimers(
  model: Readonly<Model>,
  ctx: Ctx,
  target: Target,
  match: (command: { name: string; input: unknown }) => boolean,
): PendingEvent[] {
  return Object.values(model.timers)
    .filter((t) => match(t.command))
    .map((t) => makeEvent(ctx, HUB, target, 'timer.cancelled', { timerId: t.timerId }));
}

export function inputField(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}
