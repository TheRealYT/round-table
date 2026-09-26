import type { PendingEvent, Principal } from '@round-table/protocol';
import type { Ctx } from './ports.ts';

/**
 * A typed refusal. Nothing is written; the router returns it as an `err` frame with code
 * `rejected` and this object in `details` (e.g. `already_claimed` with the owner).
 */
export interface Rejection {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Decision = { ok: true; events: PendingEvent[] } | { ok: false; rejection: Rejection };

export function accept(...events: PendingEvent[]): Decision {
  return { ok: true, events };
}

export function reject(code: string, message: string, details?: Record<string, unknown>): Decision {
  return details === undefined ? { ok: false, rejection: { code, message } } : { ok: false, rejection: { code, message, details } };
}

/** A command as the bus hands it to core: the procedure (or internal command) name, its validated input, and who sent it. */
export interface Command<I = unknown> {
  name: string;
  input: I;
  principal: Principal;
}

/**
 * The shape of every domain module (projects, pairing, roster, messaging, board, tasks, locks,
 * requests, votes, budgets, timers). `decide` and `evolve` are pure and synchronous.
 * `evolve` must accept every event `decide` can produce, and must not throw on them.
 */
export interface DomainModule<S> {
  readonly name: string;
  initial(): S;
  /** The command names this module handles. The bus routes by this list. */
  readonly handles: readonly string[];
  decide(state: S, command: Command, ctx: Ctx): Decision;
  /** Event types this module folds into its state. */
  readonly folds: readonly string[];
  evolve(state: S, event: PendingEvent): S;
}

/** Rebuilds a module's state from events: the basis of replay, snapshots and time travel. */
export function replay<S>(module: DomainModule<S>, events: Iterable<PendingEvent>, from: S = module.initial()): S {
  let state = from;
  for (const event of events) {
    if (module.folds.includes(event.type)) state = module.evolve(state, event);
  }
  return state;
}
