import { describe, expect, it } from 'vitest';
import { SECTIONS, getSection } from '../src/index.ts';

// The 20 sections named in the spec (Shared board → Sections), in spec order.
const SPEC_SECTIONS = [
  'goal', 'rules', 'plan', 'tasks', 'task_log', 'roster', 'activity', 'interfaces', 'decisions', 'knowledge',
  'questions', 'requests', 'locks', 'artifacts', 'quality', 'incidents', 'access', 'budgets', 'human_inbox', 'digest',
];

describe('section registry', () => {
  it('declares exactly the 20 spec sections, in spec order', () => {
    expect(SECTIONS.map((s) => s.name)).toEqual(SPEC_SECTIONS);
  });

  it('keeps locks repo-scoped and everything else project-scoped', () => {
    for (const s of SECTIONS) expect(s.stream).toBe(s.name === 'locks' ? 'repo' : 'project');
  });

  it('only commits through hub, leader or human (spec: one writer, many voices)', () => {
    for (const s of SECTIONS) {
      expect(s.committers.length).toBeGreaterThan(0);
      for (const c of s.committers) expect(['hub', 'leader', 'human']).toContain(c);
    }
  });

  it('routes each proposal to a committer the section actually has', () => {
    for (const s of SECTIONS) {
      if (s.proposals) expect(s.committers).toContain(s.proposals.committedBy);
    }
  });

  it('sets a leader requirement only where the leader commits', () => {
    for (const s of SECTIONS) {
      if (!s.committers.includes('leader')) expect(s.leaderRequires).toBe('none');
    }
  });

  it('lets only the human write access, and routes agent incidents through a hub rule', () => {
    expect(getSection('access')).toMatchObject({ committers: ['human'], proposals: null });
    expect(getSection('incidents')?.proposals).toEqual({ committedBy: 'hub' });
  });

  it('never accepts proposals for hub-recorded state (D1)', () => {
    for (const name of ['task_log', 'roster', 'activity', 'requests', 'locks', 'quality', 'budgets']) {
      expect(getSection(name)?.proposals).toBeNull();
    }
  });
});
