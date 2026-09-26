import type { IdKind } from '@round-table/protocol';

/** Time source. The hub passes the real clock; tests pass testkit's FakeClock (ADR-0010). */
export interface Clock {
  now(): number;
}

/** Id source. Ids are minted outside core and handed in, so replay never mints new ones. */
export interface IdGen {
  next(kind: IdKind): string;
}

/** Randomness for things like match phrases. The hub passes crypto randomness; tests pass a seeded one. */
export interface Random {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/** Everything `decide` may use besides the model and the command. `evolve` gets none of it. */
export interface Ctx {
  now: number;
  ids: IdGen;
  random: Random;
  settings: Settings;
}

/** Timeouts and limits from the spec. The human can change them in Settings (S4 makes them per project). */
export interface Settings {
  pairingRequestTtlMs: number;
  pairingCodeTtlMs: number;
  pairingMaxAttempts: number;
  pairingMaxPendingPerOrigin: number;
  staleAfterMs: number;
  graceMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pairingRequestTtlMs: 10 * 60_000,
  pairingCodeTtlMs: 5 * 60_000,
  pairingMaxAttempts: 3,
  pairingMaxPendingPerOrigin: 5,
  staleAfterMs: 3 * 60_000,
  graceMs: 10 * 60_000,
};
