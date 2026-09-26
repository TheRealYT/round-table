import { randomBytes, randomInt } from 'node:crypto';
import { ID_PREFIX, type IdKind } from '@round-table/protocol';
import type { Clock, IdGen, Random } from '@round-table/core';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48-bit millisecond time + 80 random bits, Crockford base32, 26 chars. */
export function ulid(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

export class UlidIds implements IdGen {
  private readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  next(kind: IdKind): string {
    return `${ID_PREFIX[kind]}_${ulid(this.clock.now())}`;
  }
}

export const cryptoRandom: Random = { int: (max) => randomInt(max) };

export const systemClock: Clock = { now: () => Date.now() };
