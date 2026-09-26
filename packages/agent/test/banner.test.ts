import { describe, expect, it } from 'vitest';
import { inboxBanner } from '../src/index.ts';

const none = { human: 0, critical: 0, direct: 0, normal: 0, digest: 0 };

describe('piggyback banner', () => {
  it('is empty when nothing is pending', () => {
    expect(inboxBanner(none)).toBe('');
  });

  it('lists counts in priority order and urges wait for human or critical', () => {
    expect(inboxBanner({ ...none, normal: 3, human: 1 })).toBe('⟪inbox: 1 human · 3 normal (call wait now)⟫');
    expect(inboxBanner({ ...none, direct: 2 })).toBe('⟪inbox: 2 direct⟫');
  });

  it('adds the activity reminder', () => {
    expect(inboxBanner(none, true)).toBe('⟪activity report due⟫');
  });
});
