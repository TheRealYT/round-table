import { z } from 'zod';
import { AgentId, TaskId, TicketId } from './ids.ts';

/**
 * `data` schemas per board section (ADR-0007). A proposal or human edit is validated against the
 * section's schema before anything is written. Sections without a schema here are not built yet.
 */
export const GoalData = z.object({
  objective: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
});
export type GoalData = z.infer<typeof GoalData>;

export const RulesData = z.object({
  /** Run by the hub on the merge result before main moves (ADR-0009), in a shell, from the repo root. */
  testCommand: z.string().min(1).optional(),
  testTimeoutSec: z.number().int().positive().max(3600).default(600),
  conventions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type RulesData = z.infer<typeof RulesData>;

export const DecisionData = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  options: z.array(z.string()).default([]),
  affects: z.array(z.string()).default([]),
});
export type DecisionData = z.infer<typeof DecisionData>;

export const KnowledgeData = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  urgent: z.boolean().default(false),
});
export type KnowledgeData = z.infer<typeof KnowledgeData>;

/** A task proposal (`board_propose('tasks', 'add', …)`), committed by the leader. */
export const TaskProposal = z.object({
  title: z.string().min(1).max(200),
  criteria: z.array(z.string().min(1)).min(1),
  reviewer: AgentId.optional(),
  tester: AgentId.optional(),
  /** Tasks this one waits for: task ids, or ticket ids of tasks proposed in the same plan. */
  deps: z.array(z.union([TaskId, TicketId])).default([]),
  capabilities: z.array(z.string()).default([]),
});
export type TaskProposal = z.infer<typeof TaskProposal>;

/** Opening a change request (`board_propose('artifacts', 'open', …)`), committed by the hub at once. */
export const ChangeRequestProposal = z.object({
  kind: z.literal('change_request'),
  taskId: TaskId,
  branch: z.string().min(1).regex(/^[A-Za-z0-9._/-]+$/, 'plain branch name'),
});
export type ChangeRequestProposal = z.infer<typeof ChangeRequestProposal>;

/** Refreshing a change request after new commits (`board_propose('artifacts', 'update', { changeRequestId })`). */
export const ChangeRequestRefresh = z.object({ changeRequestId: z.string().min(1) });

export const DOCUMENT_DATA: Record<string, z.ZodType> = {
  goal: GoalData,
  rules: RulesData,
  decisions: DecisionData,
  knowledge: KnowledgeData,
};
