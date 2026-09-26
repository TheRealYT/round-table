import { z } from 'zod';

/** Delivery priority, highest first (spec: Messages → Priority levels). */
export const PRIORITIES = ['human', 'critical', 'direct', 'normal', 'digest'] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/** Lower rank is delivered first. */
export function priorityRank(priority: Priority): number {
  return PRIORITIES.indexOf(priority);
}

export const MessageType = z.enum([
  'chat',
  'proposal',
  'request',
  'response',
  'activity',
  'alert',
  'vote',
  'human',
  'control',
]);
export type MessageType = z.infer<typeof MessageType>;

export const ControlAction = z.enum(['pause', 'resume', 'stop', 'dismiss']);
export type ControlAction = z.infer<typeof ControlAction>;

/** Message envelope as delivered by `wait`. Stamped by the hub, never by the sender. */
export const MessageEnvelope = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  from: z.string(),
  role: z.enum(['human', 'leader', 'worker', 'hub']),
  to: z.union([z.literal('all'), z.string(), z.array(z.string())]),
  channel: z.string().nullable(),
  type: MessageType,
  priority: Priority,
  ref: z.string().nullable(),
  body: z.string(),
  ts: z.number().int(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/** Pushed from hub to rt-agent whenever an agent's undelivered counts change (piggyback banner). */
export const InboxCounts = z.object(
  Object.fromEntries(PRIORITIES.map((p) => [p, z.number().int().nonnegative()])) as {
    [K in Priority]: z.ZodNumber;
  },
);
export type InboxCounts = z.infer<typeof InboxCounts>;
