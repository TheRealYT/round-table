import { z } from 'zod';

/**
 * The settings registry (S2c, ADR-0020): every setting with its default. Values resolve per leaf:
 * the default, then the hub-wide value, then the project's override. The human edits them in the
 * app; `settings.set` records a scope's whole override object as one event.
 */
export const SETTINGS_DEFAULTS = {
  autonomy: {
    /** Who approves the plan: the human (the spec's one approval), or the leader (full auto). */
    planApproval: 'human' as 'human' | 'leader',
  },
  budget: {
    /** Stop the project's hub-run agents when their cost reaches this many USD (warn at 80%). 0: no limit. */
    projectUsd: 0,
  },
  messaging: {
    /** A worker's message to everyone: delivered as an FYI with the next turn, or refused (name recipients). */
    workerBroadcast: 'fyi' as 'fyi' | 'off',
  },
  agents: {
    /** Model and effort per role for hub-run agents without their own; empty: the provider's. */
    leaderModel: '',
    leaderEffort: '',
    workerModel: '',
    workerEffort: '',
  },
  rules: {
    /** Rules every agent gets with its instructions (markdown). Project rules add to them. */
    team: '',
    /** Rules only the leader gets (how to plan, what to approve). */
    leader: '',
  },
  notifications: {
    /** Browser notifications when something needs the human (approvals, questions, crashes, budget). */
    needsYou: true,
    /** Browser notifications for critical alerts. */
    critical: true,
  },
  tools: {
    /** The human's terminal in the app (a shell on the hub machine, in the repo or an agent's worktree). */
    terminal: true,
  },
};

export type Settings = typeof SETTINGS_DEFAULTS;

const text = (max: number) => z.string().max(max);
const effort = z.string().max(20);

/** One scope's overrides: any subset of the leaves. */
export const SettingsOverrides = z
  .object({
    autonomy: z.object({ planApproval: z.enum(['human', 'leader']) }).partial(),
    budget: z.object({ projectUsd: z.number().min(0).max(100_000) }).partial(),
    messaging: z.object({ workerBroadcast: z.enum(['fyi', 'off']) }).partial(),
    agents: z.object({ leaderModel: text(100), leaderEffort: effort, workerModel: text(100), workerEffort: effort }).partial(),
    rules: z.object({ team: text(20_000), leader: text(20_000) }).partial(),
    notifications: z.object({ needsYou: z.boolean(), critical: z.boolean() }).partial(),
    tools: z.object({ terminal: z.boolean() }).partial(),
  })
  .partial()
  .strict();
export type SettingsOverrides = z.infer<typeof SettingsOverrides>;

/** Defaults, then each scope's overrides in order (hub, then project). */
export function resolveSettings(...scopes: Array<SettingsOverrides | undefined>): Settings {
  const out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)) as Settings;
  for (const scope of scopes) {
    if (!scope) continue;
    for (const [group, values] of Object.entries(scope)) {
      const target = (out as Record<string, Record<string, unknown>>)[group];
      if (!target || !values) continue;
      for (const [key, value] of Object.entries(values)) if (value !== undefined && key in target) target[key] = value;
    }
  }
  return out;
}
