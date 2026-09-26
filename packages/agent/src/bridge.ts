import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  mcpToolsFor,
  PRIORITIES,
  PROCEDURES,
  type InboxCounts,
  type Priority,
  type PrincipalKind,
  type ProcedureDef,
  type TransportConnector,
} from '@round-table/protocol';
import { authenticate, confirmJoin, requestJoin, type HubInfo, type SessionInfo } from './auth.ts';
import { inboxBanner, STATUS_PREFIX } from './banner.ts';
import { formatItems, formatResult, type WaitItem } from './format.ts';
import { HubClient, HubError } from '@round-table/protocol';
import type { Identity } from './identity.ts';
import { PAIRED_WELCOME, serverInstructions } from './instructions.ts';
import type { KeyStore, PendingJoin } from './keystore.ts';

export interface BridgeOptions {
  slot: string;
  connector: TransportConnector;
  keyStore: KeyStore;
  /** The agent's client, e.g. `claude-code`; shown to the human at pairing. */
  clientName: string;
  /** Longest wait: below the client's tool timeout (S0: 50 s by default, 240 s with rt agent install). */
  waitMaxMs: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Reconnect backoff after the hub connection drops. */
  reconnect?: { initialMs: number; maxMs: number };
}

type Role = 'unpaired' | 'worker' | 'leader';

/** Fields rt-agent fills itself; the model never sees them (ADR-0003). */
const FILLED: Record<string, string[]> = {
  join_request: ['publicKey', 'client'],
  join_confirm: ['signature', 'requestId'],
  rejoin: ['agentId'],
  wait: ['ack'],
};

const ACTIVITY_DUE_MS = 5 * 60_000;

/**
 * rt-agent (architecture §2): an MCP stdio server for one agent session and a hub client.
 * It owns everything mechanical, so the model sees plain tools: the key, pairing crypto,
 * automatic rejoin, delivery acks, the "[Round Table]" status line, and the tool list per role.
 */
export class AgentBridge {
  readonly server: McpServer;
  private readonly options: Required<Omit<BridgeOptions, 'log'>> & Pick<BridgeOptions, 'log'>;
  private readonly tools = new Map<string, RegisteredTool>();
  private hub: HubClient | undefined;
  private hubInfo: HubInfo | undefined;
  private identity: Identity | undefined;
  private role: Role = 'unpaired';
  private session: SessionInfo | undefined;
  private fenced = false;
  private closed = false;
  private pendingJoin: PendingJoin | undefined;
  private counts: InboxCounts = zeroCounts();
  /** Deliveries handed to the model and not yet acked, with their priority (acked on the next wait). */
  private handed = new Map<number, Priority>();
  private lastActivityAt: number;
  private reconnectDelay: number;

  constructor(options: BridgeOptions) {
    this.options = {
      now: () => Date.now(),
      reconnect: { initialMs: 500, maxMs: 15_000 },
      ...options,
    };
    this.lastActivityAt = this.options.now();
    this.reconnectDelay = this.options.reconnect.initialMs;
    this.server = new McpServer(
      { name: 'roundtable', version: '0.1.0' },
      { instructions: serverInstructions(Math.round(options.waitMaxMs / 1000)), capabilities: { tools: { listChanged: true } } },
    );
    for (const def of PROCEDURES.filter((p) => p.mcp)) this.register(def);
    this.server.registerPrompt(
      'join',
      { description: 'Join the Round Table: pair this session with the hub, or resume if already paired.' },
      () => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: 'Join the Round Table. If you are not paired yet, call join_request with a short name for yourself, show me the match phrase, and wait for me to paste the code. If you are already paired, call wait and follow the Round Table protocol.',
          },
        }],
      }),
    );
    this.applyRole();
  }

  /** Connects to the hub (and rejoins if this slot has an identity), then serves MCP on `transport`. */
  async start(transport: McpTransport): Promise<void> {
    await this.connectHub().catch((error: unknown) => {
      this.log(`hub not reachable yet (${errorText(error)}); retrying in the background`);
      this.scheduleReconnect();
    });
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.hub?.close('rt-agent closing');
    await this.server.close();
  }

  get currentRole(): Role | 'fenced' {
    return this.fenced ? 'fenced' : this.role;
  }

  // ── hub connection ────────────────────────────────────────────────────────────────────

  private async connectHub(): Promise<void> {
    const client = new HubClient(await this.options.connector.connect('agent'));
    client.on('inbox', (data) => {
      this.counts = data as InboxCounts;
    });
    client.on('role', (data) => {
      this.role = (data as { role: Role }).role;
      this.applyRole();
    });
    client.on('fenced', () => {
      this.fenced = true;
      this.log('fenced: a newer session proved this identity; this one stops');
      this.applyRole();
    });
    client.onClose(() => {
      if (this.hub === client) this.hub = undefined;
      if (!this.closed && !this.fenced) this.scheduleReconnect();
    });
    this.hubInfo = await client.call<HubInfo>('hub.info');
    this.hub = client;
    this.identity = await this.options.keyStore.load(this.hubInfo.hubId, this.options.slot);
    if (this.identity) await this.authenticate();
    this.reconnectDelay = this.options.reconnect.initialMs;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.fenced) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnect.maxMs);
    const timer = setTimeout(() => {
      this.connectHub().catch((error: unknown) => {
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
    this.applyRole();
    this.log(`authenticated as ${this.identity.agentId} (${session.role}, epoch ${session.epoch}, ${session.resumed ? 'resumed' : 'new joiner'})`);
  }

  // ── tools ─────────────────────────────────────────────────────────────────────────────

  private register(def: ProcedureDef): void {
    const hidden = new Set([...(FILLED[def.name] ?? []), 'projectId']);
    const shape = (def.input as z.ZodObject).shape;
    const input = z.object(Object.fromEntries(Object.entries(shape).filter(([key]) => !hidden.has(key))));
    const tool = this.server.registerTool(
      def.name,
      { description: def.summary, inputSchema: input },
      async (args: Record<string, unknown>) => this.call(def.name, args),
    );
    this.tools.set(def.name, tool);
  }

  /** Shows the tools this session may use now; the SDK sends tools/list_changed (S0: honored mid-session). */
  private applyRole(): void {
    let visible: Set<string>;
    if (this.fenced) visible = new Set();
    else if (this.role !== 'unpaired') visible = new Set(mcpToolsFor(this.role as PrincipalKind).map((p) => p.name));
    else if (this.identity) visible = new Set(['rejoin']);
    else visible = new Set(['join_request', 'join_confirm']);
    for (const [name, tool] of this.tools) {
      if (visible.has(name) && !tool.enabled) tool.enable();
      if (!visible.has(name) && tool.enabled) tool.disable();
    }
  }

  private async call(name: string, args: Record<string, unknown>) {
    try {
      if (this.fenced) throw new HubError('fenced', 'this session was replaced by a newer one with the same identity; stop working in this session');
      const hub = this.hub;
      if (!hub) throw new HubError('internal', 'the Round Table hub is unreachable; rt-agent keeps retrying. Try again shortly.');
      const text = await this.dispatch(hub, name, args);
      const status = await this.statusLine(hub, name);
      return { content: [{ type: 'text' as const, text: status ? `${text}\n\n${status}` : text }] };
    } catch (error) {
      const e = error instanceof HubError ? error : new HubError('internal', errorText(error));
      const reason = e.rejection ? `${e.rejection}: ${e.message}` : `${e.code}: ${e.message}`;
      return { content: [{ type: 'text' as const, text: `${STATUS_PREFIX} ${name} failed (${reason})` }], isError: true };
    }
  }

  private async dispatch(hub: HubClient, name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'join_request': {
        if (this.identity) return `Already paired as ${this.identity.agentId}.`;
        this.pendingJoin = await requestJoin(hub, {
          name: String(args.name),
          client: this.options.clientName,
          tags: (args.tags as string[] | undefined) ?? [],
          capabilities: (args.capabilities as string[] | undefined) ?? [],
        });
        await this.options.keyStore.savePending(this.options.slot, this.pendingJoin);
        return `Join request sent. Show the human this match phrase: ${this.pendingJoin.request.matchPhrase}
They will check it in the Round Table app, click Allow, and paste an 8-character code into this chat. Then call join_confirm with that code.`;
      }
      case 'join_confirm': {
        // After an rt-agent restart the pending request comes back from the key store.
        this.pendingJoin ??= this.hubInfo ? await this.options.keyStore.loadPending(this.hubInfo.hubId, this.options.slot) : undefined;
        if (!this.pendingJoin) throw new HubError('invalid_input', 'call join_request first');
        const identity = await confirmJoin(hub, this.pendingJoin, String(args.code), this.options.now());
        await this.options.keyStore.save(this.options.slot, identity);
        await this.options.keyStore.clearPending(identity.hubId, this.options.slot);
        this.identity = identity;
        this.pendingJoin = undefined;
        await this.authenticate();
        return PAIRED_WELCOME(this.role, this.session?.projectId ?? 'unknown');
      }
      case 'rejoin':
        await this.authenticate();
        return `Rejoined as ${this.identity?.agentId} (${this.role}).`;
      case 'wait': {
        const timeoutMs = Math.min(typeof args.timeoutMs === 'number' ? args.timeoutMs : this.options.waitMaxMs, this.options.waitMaxMs);
        const out = await this.fetch(hub, { ...args, timeoutMs });
        return formatItems(out.items, out.more);
      }
      case 'activity':
        this.lastActivityAt = this.options.now();
        return formatResult(await hub.call(name, args));
      default:
        return formatResult(await hub.call(name, args));
    }
  }

  /** One wait round trip: acks what the model already has, records what it hands over now. */
  private async fetch(hub: HubClient, args: Record<string, unknown>): Promise<{ items: WaitItem[]; more: number }> {
    const out = await hub.call<{ items: WaitItem[]; more: number }>('wait', { ...args, ack: [...this.handed.keys()] });
    this.handed = new Map(out.items.map((i) => [i.deliveryId, i.priority as Priority]));
    return out;
  }

  /**
   * The piggyback status line (ADR-0001). Human and critical messages are handed over inline, so
   * a busy agent sees them at its next Round Table call; anything else is reported as counts.
   */
  private async statusLine(hub: HubClient, tool: string): Promise<string> {
    if (tool === 'wait' || this.role === 'unpaired') return '';
    const pending = this.pendingCounts();
    if (pending.human + pending.critical > 0) {
      const out = await this.fetch(hub, { timeoutMs: 1 });
      if (out.items.length > 0) return `${STATUS_PREFIX} messages for you:\n${formatItems(out.items, out.more)}`;
    }
    return inboxBanner(this.pendingCounts(), this.options.now() - this.lastActivityAt > ACTIVITY_DUE_MS);
  }

  /** Hub counts minus what the model already holds (acked on its next wait). */
  private pendingCounts(): InboxCounts {
    const counts = { ...this.counts };
    for (const priority of this.handed.values()) counts[priority] = Math.max(0, counts[priority] - 1);
    return counts;
  }

  private log(message: string): void {
    this.options.log?.(`[rt-agent ${this.options.slot}] ${message}`);
  }
}

function zeroCounts(): InboxCounts {
  return Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as InboxCounts;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
