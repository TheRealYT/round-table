import { DEFAULT_SETTINGS, evolve, initialModel, type Clock, type IdGen, type Model, type Random, type Settings } from '@round-table/core';
import type { EventPayloads, TransportListener } from '@round-table/protocol';
import { fingerprint, randomToken, type KeyPair } from '@round-table/protocol/crypto';
import { Bus } from './command-bus.ts';
import { Gateway } from './gateway.ts';
import { cryptoRandom, systemClock, UlidIds } from './ids.ts';
import { DEFAULT_HUB_CONFIG, type HubConfig, type HubInternals } from './internals.ts';
import { deliveriesProjector } from './projectors/deliveries.ts';
import { Router } from './router.ts';
import { TimerScheduler } from './scheduler.ts';
import { SqliteEventStore } from './sqlite-store.ts';
import { Waiters } from './waiters.ts';

export interface HubOptions {
  /** SQLite file, or ':memory:' for tests. */
  storePath: string;
  /** The hub's own Ed25519 key (see `loadOrCreateHubKey`). Its fingerprint is the hub id. */
  hubKey: KeyPair;
  clock?: Clock;
  ids?: IdGen;
  random?: Random;
  settings?: Partial<Settings>;
  config?: Partial<HubConfig>;
  /** Arm real timers. Scenario tests turn this off and call `tick()` after moving a FakeClock. */
  autoTimers?: boolean;
}

/** rt-hub: the IO shell around the pure core (architecture §3). */
export class Hub {
  readonly hubId: string;
  readonly model: Model;
  readonly store: SqliteEventStore;
  readonly bus: Bus;
  readonly scheduler: TimerScheduler;
  private readonly gateway: Gateway;
  private readonly waiters: Waiters;
  private readonly humanSessions = new Set<string>();
  private readonly loginTokens = new Map<string, number>();
  private readonly clock: Clock;
  private readonly detach: Array<() => void> = [];

  constructor(options: HubOptions) {
    const clock = options.clock ?? systemClock;
    const ids = options.ids ?? new UlidIds(clock);
    const random = options.random ?? cryptoRandom;
    const settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };
    const config: HubConfig = { ...DEFAULT_HUB_CONFIG, ...options.config };
    this.clock = clock;
    this.hubId = `hub_${fingerprint(options.hubKey.publicKey).slice('SHA256:'.length)}`;

    this.store = new SqliteEventStore(options.storePath, [deliveriesProjector]);
    this.model = initialModel();
    for (const row of this.store.all()) evolve(this.model, row);

    this.bus = new Bus({ store: this.store, model: this.model, ctx: () => ({ now: clock.now(), ids, random, settings }) });
    this.waiters = new Waiters({ coalesceMs: config.coalesceMs });

    const internals: HubInternals = {
      hubId: this.hubId,
      hubKey: options.hubKey,
      model: this.model,
      store: this.store,
      bus: this.bus,
      waiters: this.waiters,
      clock,
      config,
      pushInbox: (agentId) => this.gateway.pushInbox(agentId),
    };
    this.gateway = new Gateway(internals, new Router(internals), (cookie) => this.humanSessions.has(cookie));

    this.scheduler = new TimerScheduler({ clock, auto: options.autoTimers ?? true });
    this.bus.onCommit((rows) => {
      for (const row of rows) {
        if (row.type === 'timer.scheduled') this.scheduler.add(row.payload as EventPayloads['timer.scheduled']);
        if (row.type === 'timer.cancelled' || row.type === 'timer.fired') {
          this.scheduler.cancel((row.payload as EventPayloads['timer.cancelled']).timerId);
        }
      }
    });
    this.scheduler.load(Object.values(this.model.timers));
    // Hub restart: nobody is connected any more. Agents that were get the normal stale/grace
    // timers, so reconnecting within the grace period resumes them (spec: Hub restarts).
    for (const project of Object.values(this.model.projects)) {
      for (const entry of Object.values(project.roster)) {
        if (entry.connected) this.bus.dispatch('session.closed', { agentId: entry.agentId, epoch: entry.epoch }, { kind: 'hub', component: 'startup' });
      }
    }
    this.scheduler.start((timer) => {
      this.bus.dispatch(timer.command.name, timer.command.input, { kind: 'hub', component: 'scheduler' }, { timerId: timer.timerId });
    });
  }

  /** Accept connections from a listener (WebSocket, or MemoryNetwork in tests). */
  listen(listener: TransportListener): void {
    this.detach.push(this.gateway.attach(listener));
  }

  /** Fire timers that are due at the current clock time (tests; real timers fire on their own). */
  tick(): number {
    return this.scheduler.tick();
  }

  /** One-time login token for the human app; `rt hub start` prints it as a URL. Valid 10 minutes. */
  createLoginToken(): string {
    const token = randomToken();
    this.loginTokens.set(token, this.clock.now() + 10 * 60_000);
    return token;
  }

  /** Trades a login token for a session cookie value, once. */
  redeemLoginToken(token: string): string | undefined {
    const expires = this.loginTokens.get(token);
    this.loginTokens.delete(token);
    if (expires === undefined || expires < this.clock.now()) return undefined;
    return this.createHumanSession();
  }

  createHumanSession(): string {
    const session = randomToken();
    this.humanSessions.add(session);
    return session;
  }

  close(): void {
    this.scheduler.stop();
    this.waiters.cancelAll();
    for (const d of this.detach) d();
    this.gateway.closeAll();
    this.store.close();
  }
}
