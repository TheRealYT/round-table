import { describe, expect, it } from 'vitest';
import { canTransition, TASK_STATUSES } from '../src/index.ts';

describe('task state machine', () => {
  it('follows the happy path by hub rules', () => {
    const path = ['proposed', 'ready', 'claimed', 'in_progress', 'in_review', 'in_test'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!, 'hub_rule')).toBe(true);
  });

  it('reaches done only through the done rule, and only from in_test', () => {
    for (const from of TASK_STATUSES) {
      expect(canTransition(from, 'done', 'hub_rule')).toBe(false);
      expect(canTransition(from, 'done', 'human')).toBe(false);
      expect(canTransition(from, 'done', 'done_rule')).toBe(from === 'in_test');
    }
  });

  it('allows blocked and cancelled from any non-terminal state', () => {
    for (const from of TASK_STATUSES.filter((s) => s !== 'done' && s !== 'cancelled')) {
      expect(canTransition(from, 'blocked', 'hub_rule')).toBe(true);
      expect(canTransition(from, 'cancelled', 'human')).toBe(true);
    }
  });

  it('lets only the human reopen a finished task', () => {
    expect(canTransition('done', 'ready', 'hub_rule')).toBe(false);
    expect(canTransition('done', 'ready', 'human')).toBe(true);
    expect(canTransition('cancelled', 'in_progress', 'human')).toBe(false);
  });
});
