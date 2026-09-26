import type { PendingEvent, Principal } from '@round-table/protocol';
import type { Model } from './model.ts';
import type { Ctx } from './ports.ts';

/**
 * A typed refusal. The router returns it as an `err` frame with code `rejected` and this object
 * in `details` (e.g. `already_claimed` with the owner).
 */
export interface Rejection {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * What a command handler decides. A rejection may still carry events that must be recorded
 * (e.g. a wrong pairing code counts as a failed attempt).
 */
export type Decision =
  | { ok: true; events: PendingEvent[]; output?: unknown }
  | { ok: false; rejection: Rejection; events: PendingEvent[] };

export function accept(events: PendingEvent[], output?: unknown): Decision {
  return output === undefined ? { ok: true, events } : { ok: true, events, output };
}

export function reject(code: string, message: string, details?: Record<string, unknown>, events: PendingEvent[] = []): Decision {
  const rejection: Rejection = details === undefined ? { code, message } : { code, message, details };
  return { ok: false, rejection, events };
}

/** A command as the bus hands it to core: name, validated (and hub-prepared) input, and caller. */
export interface Command<I = unknown> {
  name: string;
  input: I;
  principal: Principal;
}

/** Decides one command against the model. Pure: no IO, no clock, no randomness except through ctx. */
export type CommandHandler<I = any> = (model: Readonly<Model>, command: Command<I>, ctx: Ctx) => Decision;
