import type { Clock } from '@round-table/core';

/** A clock tests move by hand. Timers and timeouts in scenarios run in milliseconds of real time (ADR-0010). */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = Date.UTC(2026, 8, 26, 9, 0, 0)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (ms < 0) throw new Error('time only moves forward');
    this.current += ms;
    return this.current;
  }

  set(ts: number): void {
    if (ts < this.current) throw new Error('time only moves forward');
    this.current = ts;
  }
}
