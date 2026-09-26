import { z } from 'zod';

/**
 * Every event belongs to exactly one stream (ADR-0005):
 * - system: pairing before a project is chosen, identities and keys, projects list, global budget
 * - project:<id>: everything inside one round table
 * - repo:<id>: locks and worktrees shared by all projects on one repo
 */
export const StreamId = z.union([
  z.literal('system'),
  z.templateLiteral(['project:', z.string().min(1)]),
  z.templateLiteral(['repo:', z.string().min(1)]),
]);
export type StreamId = z.infer<typeof StreamId>;

export type StreamKind = 'system' | 'project' | 'repo';

export function streamKind(stream: StreamId): StreamKind {
  if (stream === 'system') return 'system';
  return stream.startsWith('project:') ? 'project' : 'repo';
}

/** Durable events are never pruned; ephemeral ones are pruned by retention (ADR-0006). */
export const Durability = z.enum(['durable', 'ephemeral']);
export type Durability = z.infer<typeof Durability>;

export const Role = z.enum(['human', 'leader', 'worker', 'hub']);
export type Role = z.infer<typeof Role>;

/** Who committed the change (spec: "One writer, many voices"). */
export const Via = z.enum(['hub', 'leader', 'human']);
export type Via = z.infer<typeof Via>;

/** Links to other entities. Provenance and the app's "Why?" tab are built from these. */
export const Refs = z.object({
  task: z.array(z.string()).optional(),
  message: z.array(z.string()).optional(),
  decision: z.array(z.string()).optional(),
  request: z.array(z.string()).optional(),
  entry: z.array(z.string()).optional(),
  ticket: z.array(z.string()).optional(),
  changeRequest: z.array(z.string()).optional(),
});
export type Refs = z.infer<typeof Refs>;

/** An event as `core.decide` produces it; the store assigns positions. */
export const PendingEvent = z.object({
  stream: StreamId,
  projectId: z.string().nullable(),
  type: z.string().min(1),
  actor: z.string().min(1),
  role: Role,
  via: Via,
  ts: z.number().int(),
  refs: Refs,
  payload: z.unknown(),
  reason: z.string().nullable(),
  durability: Durability,
});
export type PendingEvent = z.infer<typeof PendingEvent>;

/** One row of the append-only log. */
export const EventRow = PendingEvent.extend({
  /** Global position: total order across all streams. */
  gpos: z.number().int().positive(),
  /** Per-stream sequence, gap-free from 1. Agents and the app use it as `since_seq`. */
  sseq: z.number().int().positive(),
});
export type EventRow = z.infer<typeof EventRow>;
