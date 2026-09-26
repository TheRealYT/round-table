import { describe, expect, it } from 'vitest';
import { inboxBanner } from '../src/index.ts';

const none = { human: 0, critical: 0, direct: 0, normal: 0, digest: 0 };

describe('piggyback status line', () => {
  it('is empty when nothing is pending', () => {
    expect(inboxBanner(none)).toBe('');
  });

  it('states counts in priority order, factually', () => {
    expect(inboxBanner({ ...none, normal: 3, human: 1 })).toBe('[Round Table] inbox: 4 messages waiting (1 human, 3 normal). Read with wait.');
    expect(inboxBanner({ ...none, direct: 1 })).toBe('[Round Table] inbox: 1 message waiting (1 direct). Read with wait.');
  });

  it('adds the activity reminder', () => {
    expect(inboxBanner(none, true)).toBe('[Round Table] activity report due (no activity call in the last 5 min).');
  });
});
