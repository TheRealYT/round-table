import type { IdKind } from '@round-table/protocol';

/** Time source. The hub passes the real clock; tests pass testkit's FakeClock (ADR-0010). */
export interface Clock {
  now(): number;
}

/** Id source. Ids are minted outside core and handed in, so replay never mints new ones. */
export interface IdGen {
  next(kind: IdKind): string;
}

/** Everything `decide` may use besides state and the command. */
export interface Ctx {
  now: number;
  ids: IdGen;
}
