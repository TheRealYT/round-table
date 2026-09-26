import type { Random } from '@round-table/core';

/** Deterministic randomness for tests (mulberry32). */
export class SeededRandom implements Random {
  private state: number;
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }
  int(maxExclusive: number): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
  }
}
