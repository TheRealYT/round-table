import type { EventRow, Principal } from '@round-table/protocol';
import type { Rejection } from '@round-table/core';

export type CommandResult =
  | { ok: true; events: EventRow[]; output: unknown }
  | { ok: false; rejection: Rejection; events: EventRow[] };

/**
 * The single serialized writer (ADR-0005). Commands from agents, the human, reactors and the
 * scheduler all come through here, one at a time, each in its own transaction.
 */
export interface CommandBus {
  dispatch(name: string, input: unknown, principal: Principal, options?: { timerId?: string }): CommandResult;
}

/**
 * A process manager: reacts to committed events by doing IO outside the bus (git, tests,
 * exports) and dispatching result commands. Reactors never write the store directly.
 */
export interface Reactor {
  readonly name: string;
  readonly handles: readonly string[];
  react(row: EventRow, bus: CommandBus): Promise<void>;
}
