import {
  HubClient,
  HubError,
  PRIORITIES,
  type InboxCounts,
  type Priority,
  type TransportConnector,
} from '@round-table/protocol';
import { authenticate, confirmJoin, requestJoin, type HubInfo, type SessionInfo } from './auth.ts';
import { inboxBanner, STATUS_PREFIX } from './banner.ts';
import { formatItems, formatResult, type WaitItem } from './format.ts';
import type { Identity } from './identity.ts';
import { briefing, LOOP_REMINDER, PAIRED_WELCOME, roleBrief } from './instructions.ts';
import type { KeyStore, PendingJoin } from './keystore.ts';

export type Role = 'unpaired' | 'worker' | 'leader';

export interface SessionOptions {
  slot: string;
  connector: TransportConnector;
  keyStore: KeyStore;
  clientName: string;
  waitMaxMs: number;
  briefing: boolean;
  now: () => number;
  reconnect: { initialMs: number; maxMs: number };
  log: (message: string) => void;
  /** Called when the role or fenced state changes (the bridge updates the tool list). */
  onChange: () => void;
}

const ACTIVITY_DUE_MS = 5 * 60_000;

/**
 * One agent inside rt-agent: its identity slot, its own authenticated hub connection, and the
 * per-agent state behind the status and next-step lines. One rt-agent can hold several (ADR-0016):
 * IDEs may run one MCP server for many chats, and each chat is its own agent.
 */
export class AgentSession {
  readonly slot: string;
  private readonly o: SessionOptions;
  private hub: HubClient | undefined;
  hubInfo: HubInfo | undefined;
  identity: Identity | undefined;
  role: Role = 'unpaired';
  fenced = false;
  private session: SessionInfo | undefined;
  private closed = false;
  pendingJoin: PendingJoin | undefined;
  private counts: InboxCounts = zeroCounts();
  /** Deliveries handed to the model and not yet acked, with their priority (acked on the next wait). */
  private handed = new Map<number, Priority>();
  private handedHuman = false;
  private roleChanged = false;
  private briefed = false;
  /** Last boardVersion relayed to the model (filled into proposals as baseSeq). */
  private boardVersion: number | undefined;
  private lastActivityAt: number;
  private reconnectDelay: number;

  constructor(options: SessionOptions) {
    this.o = options;
    this.slot = options.slot;
    this.lastActivityAt = options.now();
    this.reconnectDelay = options.reconnect.initialMs;
  }

  get connected(): boolean {
    return this.hub !== undefined;
  }

  get agentId(): string | undefined {
    return this.identity?.agentId;
  }

  /** Connects to the hub and rejoins if this slot already has an identity. */
  async connect(): Promise<void> {
    const client = new HubClient(await this.o.connector.connect('agent'));
    client.on('inbox', (data) => {
      this.counts = data as InboxCounts;
    });
    client.on('role', (data) => {
      this.role = (data as { role: Role }).role;
      this.roleChanged = true;
      this.o.onChange();
    });
    client.on('fenced', () => {
      this.fenced = true;
      this.log('fenced: a newer session proved this identity; this one stops');
      this.o.onChange();
    });
    client.onClose(() => {
      if (this.hub === client) this.hub = undefined;
      if (!this.closed && !this.fenced) this.scheduleReconnect();
    });
    this.hubInfo = await client.call<HubInfo>('hub.info');
    this.hub = client;
    this.identity = await this.o.keyStore.load(this.hubInfo.hubId, this.slot);
    this.pendingJoin ??= await this.o.keyStore.loadPending(this.hubInfo.hubId, this.slot);
    if (this.identity) await this.authenticate();
    this.reconnectDelay = this.o.reconnect.initialMs;
  }

  /** Like connect, but a failure starts background retries instead of throwing. */
  async connectOrRetry(): Promise<void> {
    await this.connect().catch((error: unknown) => {
      this.log(`hub not reachable yet (${errorText(error)}); retrying in the background`);
      this.scheduleReconnect();
    });
  }

  close(): void {
    this.closed = true;
    this.hub?.close('rt-agent closing');
  }

  private scheduleReconnect(): void {
    if (this.closed || this.fenced) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.o.reconnect.maxMs);
    const timer = setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this.log(`reconnect failed (${errorText(error)})`);
        this.scheduleReconnect();
      });
    }, delay);
    timer.unref?.();
  }

  private async authenticate(): Promise<void> {
    if (!this.hub || !this.identity) return;
    const session = await authenticate(this.hub, this.identity);
    this.session = session;
    this.role = session.role;
    this.handed.clear(); // unacked deliveries are re-sent by the hub (at-least-once)
    this.o.onChange();
    this.log(`authenticated as ${this.identity.agentId} (${session.role}, epoch ${session.epoch}, ${session.resumed ? 'resumed' : 'new joiner'})`);
  }

  /** Runs one tool for this agent and returns the text the model sees. */
  async handle(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    try {
      if (this.fenced) throw new HubError('fenced', 'this session was replaced by a newer one with the same identity; stop working in this session');
      const hub = this.hub;
      if (!hub) throw new HubError('internal', 'the Round Table hub is unreachable; rt-agent keeps retrying. Try again shortly.');
      if (this.role === 'unpaired' && !['join_request', 'join_confirm', 'rejoin'].includes(name)) {
        throw new HubError('forbidden', this.identity ? 'not connected to the hub yet; try again shortly' : 'not joined yet: call join_request with your name first');
      }
      const text = await this.dispatch(hub, name, args);
      const parts = [text, await this.statusLine(hub, name), await this.nextLine(hub)];
      if (this.o.briefing && !this.briefed) {
        parts.push(briefing(Math.round(this.o.waitMaxMs / 1000)));
        this.briefed = true;
      }
      return { text: parts.filter(Boolean).join('\n\n') };
    } catch (error) {
      const e = error instanceof HubError ? error : new HubError('internal', errorText(error));
      const reason = e.rejection ? `${e.rejection}: ${e.message}` : `${e.code}: ${e.message}`;
      const next = this.hub && !this.fenced ? await this.nextLine(this.hub).catch(() => '') : '';
      return { text: [`${STATUS_PREFIX} ${name} failed (${reason})`, next].filter(Boolean).join('\n\n'), isError: true };
    }
  }

  private async dispatch(hub: HubClient, name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'join_request': {
        if (this.identity) {
          // This name already has an identity: rejoin it; no code needed.
          if (this.role === 'unpaired') await this.authenticate();
          return `Welcome back: you are already paired as ${this.identity.agentId} (${this.role}); no code needed.\n${PAIRED_WELCOME(this.role, this.session?.projectId ?? 'unknown')}`;
        }
        this.pendingJoin = await requestJoin(hub, {
          name: String(args.name),
          client: this.o.clientName,
          tags: (args.tags as string[] | undefined) ?? [],
          capabilities: (args.capabilities as string[] | undefined) ?? [],
        });
        await this.o.keyStore.savePending(this.slot, this.pendingJoin);
        return `Join request sent. Show the human this match phrase: ${this.pendingJoin.request.matchPhrase}
They will check it in the Round Table app, click Allow, and paste an 8-character code into this chat. Then call join_confirm with that code.`;
      }
      case 'join_confirm': {
        if (!this.pendingJoin) throw new HubError('invalid_input', 'call join_request first');
        const identity = await confirmJoin(hub, this.pendingJoin, String(args.code), this.o.now());
        await this.o.keyStore.save(this.slot, identity);
        await this.o.keyStore.clearPending(identity.hubId, this.slot);
        this.identity = identity;
        this.pendingJoin = undefined;
        await this.authenticate();
        return PAIRED_WELCOME(this.role, this.session?.projectId ?? 'unknown');
      }
      case 'rejoin':
        await this.authenticate();
        return `Rejoined as ${this.identity?.agentId} (${this.role}).`;
      case 'wait': {
        const timeoutMs = Math.min(typeof args.timeoutMs === 'number' ? args.timeoutMs : this.o.waitMaxMs, this.o.waitMaxMs);
        const out = await this.fetch(hub, { ...args, timeoutMs });
        return formatItems(out.items, out.more);
      }
      case 'activity':
        this.lastActivityAt = this.o.now();
        return formatResult(await hub.call(name, args));
      case 'board_propose': {
        // D5: the proposal cites the board version the model last read, unless it gave one.
        const input = args.baseSeq === undefined && this.boardVersion !== undefined ? { ...args, baseSeq: this.boardVersion } : args;
        return formatResult(await hub.call(name, input));
      }
      default: {
        const out = await hub.call(name, args);
        const version = (out as { boardVersion?: unknown } | null)?.boardVersion;
        if (typeof version === 'number') this.boardVersion = version;
        return formatResult(out);
      }
    }
  }

  /** One wait round trip: acks what the model already has, records what it hands over now. */
  private async fetch(hub: HubClient, args: Record<string, unknown>): Promise<{ items: WaitItem[]; more: number }> {
    const out = await hub.call<{ items: WaitItem[]; more: number }>('wait', { ...args, ack: [...this.handed.keys()] });
    this.handed = new Map(out.items.map((i) => [i.deliveryId, i.priority as Priority]));
    this.handedHuman = out.items.some((i) => i.role === 'human');
    return out;
  }

  /** The piggyback status line (ADR-0001): human and critical messages inline, other mail as counts. */
  private async statusLine(hub: HubClient, tool: string): Promise<string> {
    if (tool === 'wait' || this.role === 'unpaired') return '';
    const pending = this.pendingCounts();
    if (pending.human + pending.critical > 0) {
      const out = await this.fetch(hub, { timeoutMs: 1 });
      if (out.items.length > 0) return `${STATUS_PREFIX} messages for you:\n${formatItems(out.items, out.more)}`;
    }
    return inboxBanner(this.pendingCounts(), this.o.now() - this.lastActivityAt > ACTIVITY_DUE_MS);
  }

  /** The Round Table drives the session (ADR-0015): every result ends with the next step from the board. */
  private async nextLine(hub: HubClient): Promise<string> {
    if (this.role === 'unpaired' || this.fenced) return '';
    const lines: string[] = [];
    if (this.roleChanged) {
      lines.push(`${STATUS_PREFIX} your role changed: you are now the ${this.role}. ${roleBrief(this.role)}`);
      this.roleChanged = false;
    }
    const next = await hub.call<{ tool: string; step: string }>('agent.next').catch(() => undefined);
    const human = this.handedHuman ? 'First do what the human asked above; it outranks the board. Then: ' : '';
    lines.push(`${STATUS_PREFIX} next: ${human}${next?.step ?? 'call wait.'}\n${LOOP_REMINDER}`);
    return lines.join('\n');
  }

  /** Hub counts minus what the model already holds (acked on its next wait). */
  private pendingCounts(): InboxCounts {
    const counts = { ...this.counts };
    for (const priority of this.handed.values()) counts[priority] = Math.max(0, counts[priority] - 1);
    return counts;
  }

  private log(message: string): void {
    this.o.log(`[rt-agent ${this.slot}] ${message}`);
  }
}

function zeroCounts(): InboxCounts {
  return Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as InboxCounts;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
