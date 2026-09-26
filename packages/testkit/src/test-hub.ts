import { authenticate, confirmJoin, HubClient, requestJoin, type Identity, type SessionInfo } from '@round-table/agent';
import type { Settings } from '@round-table/core';
import { Hub, type AgentHost, type Driver, type HubConfig, type SecretStore } from '@round-table/hub';
import { MemoryNetwork } from '@round-table/protocol';
import { generateIdentityKey, type KeyPair } from '@round-table/protocol/crypto';
import { FakeClock } from './fake-clock.ts';
import { SeededRandom } from './seeded-random.ts';
import { SequentialIds } from './sequential-ids.ts';

export interface TestHubOptions {
  storePath?: string;
  hubKey?: KeyPair;
  clock?: FakeClock;
  settings?: Partial<Settings>;
  config?: Partial<HubConfig>;
  /** Hub-run agents (ADR-0018): usually FakeAgentHost and FakeDriver. */
  agentHost?: AgentHost;
  drivers?: Partial<Record<string, Driver>>;
  secrets?: SecretStore;
}

export interface PairedAgent {
  client: HubClient;
  identity: Identity;
  session: SessionInfo;
}

/**
 * A real hub (real SQLite, real gateway and router) on an in-memory network with a fake clock.
 * Timers fire only when a test calls `advance`, so every timeout in the spec runs in milliseconds.
 */
export class TestHub {
  readonly hub: Hub;
  readonly clock: FakeClock;
  readonly network = new MemoryNetwork('127.0.0.1');
  readonly hubKey: KeyPair;
  human!: HubClient;
  private readonly clients: HubClient[] = [];

  private constructor(options: TestHubOptions) {
    this.clock = options.clock ?? new FakeClock();
    this.hubKey = options.hubKey ?? generateIdentityKey();
    this.hub = new Hub({
      storePath: options.storePath ?? ':memory:',
      hubKey: this.hubKey,
      clock: this.clock,
      ids: new SequentialIds(),
      random: new SeededRandom(),
      autoTimers: false,
      ...(options.settings && { settings: options.settings }),
      config: { waitMaxMs: 2_000, coalesceMs: 0, restartDelaysMs: [10, 10], ...options.config },
      ...(options.agentHost && { agentHost: options.agentHost }),
      ...(options.drivers && { drivers: options.drivers }),
      ...(options.secrets && { secrets: options.secrets }),
    });
    this.hub.listen(this.network);
  }

  static async start(options: TestHubOptions = {}): Promise<TestHub> {
    const t = new TestHub(options);
    t.human = await t.connectHuman();
    return t;
  }

  async connectHuman(): Promise<HubClient> {
    return this.track(new HubClient(await this.network.connect('app', { cookie: `rt_session=${this.hub.createHumanSession()}` })));
  }

  async connectAgent(): Promise<HubClient> {
    return this.track(new HubClient(await this.network.connect('agent')));
  }

  /** Moves the fake clock and fires every timer that became due. */
  advance(ms: number): void {
    this.clock.advance(ms);
    this.hub.tick();
  }

  /** The whole pairing ceremony: request, human allows (into `projectId` or a new project), code, confirm, authenticate. */
  async pair(name: string, target: { projectId: string } | { newProjectName: string }, tags: string[] = []): Promise<PairedAgent> {
    const client = await this.connectAgent();
    const pending = await requestJoin(client, { name, client: 'test', tags });
    const { code } = await this.human.call<{ code: string }>('pairing.allow', { requestId: pending.request.requestId, ...target });
    const identity = await confirmJoin(client, pending, code, this.clock.now());
    const session = await authenticate(client, identity);
    return { client, identity, session };
  }

  /** Opens a new connection for an existing identity (a restarted rt-agent). */
  async rejoin(identity: Identity): Promise<{ client: HubClient; session: SessionInfo }> {
    const client = await this.connectAgent();
    const session = await authenticate(client, identity);
    return { client, session };
  }

  async close(): Promise<void> {
    for (const c of this.clients) if (c.open) c.close();
    await this.network.close();
    this.hub.close();
  }

  private track(client: HubClient): HubClient {
    this.clients.push(client);
    return client;
  }
}

/** Lets pushed frames and pending promises settle (memory transport delivers on microtasks). */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
