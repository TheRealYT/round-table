import { describe, expect, it } from 'vitest';
import { TaskId } from '@round-table/protocol';
import { FakeClock, SequentialIds } from '../src/index.ts';

describe('test fakes', () => {
  it('moves the clock only forward', () => {
    const clock = new FakeClock(1000);
    expect(clock.advance(500)).toBe(1500);
    expect(() => clock.advance(-1)).toThrow();
  });

  it('mints ids that pass the protocol schemas', () => {
    const ids = new SequentialIds();
    const a = ids.next('task');
    const b = ids.next('task');
    expect(TaskId.safeParse(a).success).toBe(true);
    expect(a).not.toBe(b);
  });
});
