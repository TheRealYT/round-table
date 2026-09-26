import type { Clock, Model } from '@round-table/core';
import type { KeyPair } from '@round-table/protocol/crypto';
import type { Bus } from './command-bus.ts';
import type { GitHost } from './git.ts';
import type { SqliteEventStore } from './sqlite-store.ts';
import type { Waiters } from './waiters.ts';

/** What the gateway and router share. Built by `Hub`. */
export interface HubInternals {
  hubId: string;
  hubKey: KeyPair;
  model: Model;
  store: SqliteEventStore;
  bus: Bus;
  waiters: Waiters;
  git: GitHost;
  clock: Clock;
  config: HubConfig;
  pushInbox(agentId: string): void;
}

export interface HubConfig {
  /** Longest a `wait` may block. 50 s by default: Claude Code aborts tool calls at 60 s (S0). */
  waitMaxMs: number;
  /** Coalescing window for direct and normal deliveries. */
  coalesceMs: number;
  /** Size budget of one `wait` result, in characters of message JSON. */
  waitMaxChars: number;
  /** How long a rejoin challenge stays valid (spec: under 30 s). */
  challengeTtlMs: number;
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  waitMaxMs: 50_000,
  coalesceMs: 2_000,
  waitMaxChars: 8_000,
  challengeTtlMs: 30_000,
};
