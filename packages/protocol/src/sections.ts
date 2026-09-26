import type { Priority } from './message.ts';

/**
 * The board's section registry (ADR-0007). One declaration per section drives routing,
 * access control, notify fan-out and the human app's Board tabs. Per-section `data`
 * schemas are added next to this file as slices implement them.
 *
 * Two kinds:
 * - document: generic versioned entries (the spec's envelope + a per-section data schema)
 * - state: hub-owned aggregates with their own commands and state machine; read-only via the Board API
 */
export type SectionKind = 'document' | 'state';

/** Who may append entry versions (document) or state changes (state) for this section. */
export type Committer = 'hub' | 'leader' | 'human';

/** Extra evidence a leader commit must cite. The hub checks it in `board_commit`. */
export type LeaderRequirement =
  | 'none'
  /** a passed team vote (lazy consensus) */
  | 'vote'
  /** a passed vote with an explicit majority, or a human approval (plan changes) */
  | 'majority_or_human'
  /** a quote of a verified human message id (goal transcription) */
  | 'human_quote'
  /** recorded agreement from every affected agent (interfaces) */
  | 'agreement';

export type Audience =
  | 'everyone'
  | 'leader'
  | 'human'
  | 'owner'
  | 'reviewer'
  | 'tester'
  | 'dependents'
  | 'subscribers'
  | 'affected'
  | 'asker'
  | 'blocked'
  | 'requester'
  | 'target'
  | 'holder'
  | 'granted';

export interface NotifyRule {
  audience: readonly Audience[];
  priority: Priority;
  /** Human-readable escalation note from the spec, shown in the app and docs. */
  escalation?: string;
}

export interface SectionDef {
  name: string;
  kind: SectionKind;
  /** Where its events live. Locks are repo-scoped so projects on one repo conflict (spec: What crosses projects). */
  stream: 'project' | 'repo';
  committers: readonly Committer[];
  /** Only meaningful when 'leader' is a committer. */
  leaderRequires: LeaderRequirement;
  /**
   * Whether `board_propose` accepts this section, and who commits the resulting ticket.
   * null: no proposals; changes come from dedicated procedures (claim, lock, request…) or the human.
   */
  proposals: { committedBy: 'hub' | 'leader' } | null;
  notify: NotifyRule;
}

function section<const N extends string>(def: SectionDef & { name: N }): SectionDef & { name: N } {
  return def;
}

export const SECTIONS = [
  section({
    name: 'goal',
    kind: 'document',
    stream: 'project',
    committers: ['human', 'leader'],
    leaderRequires: 'human_quote',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['everyone'], priority: 'critical' },
  }),
  section({
    name: 'rules',
    kind: 'document',
    stream: 'project',
    committers: ['human', 'leader'],
    leaderRequires: 'vote',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['everyone'], priority: 'critical' },
  }),
  section({
    name: 'plan',
    kind: 'document',
    stream: 'project',
    committers: ['leader', 'human'],
    leaderRequires: 'majority_or_human',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['everyone'], priority: 'normal', escalation: 'critical if tasks change' },
  }),
  section({
    name: 'tasks',
    kind: 'state',
    stream: 'project',
    committers: ['leader', 'hub'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['owner', 'reviewer', 'dependents'], priority: 'direct' },
  }),
  section({
    name: 'task_log',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['owner', 'subscribers'], priority: 'normal' },
  }),
  section({
    name: 'roster',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['leader'], priority: 'normal', escalation: 'everyone if an agent drops' },
  }),
  section({
    name: 'activity',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['leader'], priority: 'digest' },
  }),
  section({
    name: 'interfaces',
    kind: 'document',
    stream: 'project',
    committers: ['leader'],
    leaderRequires: 'agreement',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['dependents'], priority: 'critical' },
  }),
  section({
    name: 'decisions',
    kind: 'document',
    stream: 'project',
    committers: ['leader', 'human'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['affected'], priority: 'direct', escalation: 'everyone if team-wide' },
  }),
  section({
    name: 'knowledge',
    kind: 'document',
    stream: 'project',
    committers: ['leader'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['everyone'], priority: 'digest', escalation: 'critical if tagged urgent' },
  }),
  section({
    name: 'questions',
    kind: 'document',
    stream: 'project',
    committers: ['leader'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['asker', 'blocked'], priority: 'direct' },
  }),
  section({
    name: 'requests',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['requester', 'target'], priority: 'direct' },
  }),
  section({
    name: 'locks',
    kind: 'state',
    stream: 'repo',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['holder', 'requester'], priority: 'direct', escalation: 'only on conflict' },
  }),
  section({
    name: 'artifacts',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: { committedBy: 'hub' },
    notify: { audience: ['reviewer', 'tester'], priority: 'direct' },
  }),
  section({
    name: 'quality',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['subscribers'], priority: 'normal', escalation: 'everyone, critical, if main breaks' },
  }),
  section({
    name: 'incidents',
    kind: 'document',
    stream: 'project',
    committers: ['hub', 'leader'],
    leaderRequires: 'none',
    // Spec: "Leader or any agent". Agents propose; a hub rule commits at once (author = agent, via = hub).
    proposals: { committedBy: 'hub' },
    notify: { audience: ['everyone', 'human'], priority: 'critical' },
  }),
  section({
    name: 'access',
    kind: 'document',
    stream: 'project',
    committers: ['human'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['granted'], priority: 'direct' },
  }),
  section({
    name: 'budgets',
    kind: 'state',
    stream: 'project',
    committers: ['hub'],
    leaderRequires: 'none',
    proposals: null,
    notify: { audience: ['leader'], priority: 'normal', escalation: 'human at 80%' },
  }),
  section({
    name: 'human_inbox',
    kind: 'document',
    stream: 'project',
    committers: ['leader', 'hub'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['human'], priority: 'direct' },
  }),
  section({
    name: 'digest',
    kind: 'document',
    stream: 'project',
    committers: ['leader'],
    leaderRequires: 'none',
    proposals: { committedBy: 'leader' },
    notify: { audience: ['everyone'], priority: 'digest' },
  }),
] as const;

export type SectionName = (typeof SECTIONS)[number]['name'];

export const SECTION_NAMES = SECTIONS.map((s) => s.name) as readonly SectionName[];

const byName = new Map<string, SectionDef>(SECTIONS.map((s) => [s.name, s]));

export function getSection(name: string): SectionDef | undefined {
  return byName.get(name);
}

export function isSectionName(name: string): name is SectionName {
  return byName.has(name);
}
