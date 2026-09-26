import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { HubClient, mcpToolsFor, PROCEDURES, type PrincipalKind, type ProcedureDef, type TransportConnector } from '@round-table/protocol';
import { AgentSession, type Role } from './agent-session.ts';
import { STATUS_PREFIX } from './banner.ts';
import { assertSlot } from './identity.ts';
import { serverInstructions, TOOL_DESCRIPTIONS } from './instructions.ts';
import type { KeyStore } from './keystore.ts';

export interface BridgeOptions {
  /**
   * Fixed identity slot: this server is one agent (Claude Code: one folder, one agent), and it
   * rejoins at startup. Without a slot, identities come from the names agents join with, so one
   * server can carry several agents, e.g. several chats of one IDE (ADR-0016).
   */
  slot?: string;
  connector: TransportConnector;
  keyStore: KeyStore;
  /** The agent's client, e.g. `claude-code`; shown to the human at pairing. */
  clientName: string;
  /** Longest wait: below the client's tool timeout (S0: 50 s by default, 240 s where install raises it). */
  waitMaxMs: number;
  /**
   * 'dynamic': tools appear per role via tools/list_changed (verified for Claude Code; fixed slot only).
   * 'static': every tool is always listed and the hub enforces who may call what (ADR-0014).
   */
  tools?: 'dynamic' | 'static';
  /** Add the protocol briefing to the first tool result, for clients that may not show server instructions. */
  briefing?: boolean;
  now?: () => number;
  log?: (message: string) => void;
  /** Reconnect backoff after the hub connection drops. */
  reconnect?: { initialMs: number; maxMs: number };
}

/** Fields rt-agent fills itself; the model never sees them (ADR-0003). */
const FILLED: Record<string, string[]> = {
  join_request: ['publicKey', 'client'],
  join_confirm: ['signature', 'requestId'],
  rejoin: ['agentId'],
  wait: ['ack'],
};

/** Catalog summary plus who may call it, so a static tool list still tells the model what applies to it. */
function describe(def: ProcedureDef): string {
  const allow = def.allow as readonly string[];
  if (allow.includes('leader') && !allow.includes('worker')) return `Leader only. ${def.summary}`;
  if (allow.includes('worker') && !allow.includes('leader')) return `Workers only. ${def.summary}`;
  return def.summary;
}

/** The identity slot for a join name: "Ada Lovelace" → "ada-lovelace". */
export function slotForName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return assertSlot(slug || 'agent');
}

const AS_FIELD = z
  .string()
  .min(1)
  .optional()
  .describe('Your Round Table name (the one you joined as). Needed only when several agents share this server.');

/**
 * rt-agent (architecture §2): an MCP stdio server and hub client. It owns everything mechanical,
 * so the model sees plain tools: keys, pairing crypto, rejoin, delivery acks, status and
 * next-step lines. Each agent it carries is an AgentSession with its own hub connection.
 */
export class AgentBridge {
  readonly server: McpServer;
  private readonly options: Required<Omit<BridgeOptions, 'log' | 'slot'>> & Pick<BridgeOptions, 'log' | 'slot'>;
  private readonly tools = new Map<string, RegisteredTool>();
  /** Agents in this server, by slot. With a fixed slot there is exactly one. */
  private readonly sessions = new Map<string, AgentSession>();
  private readonly named: boolean;

  constructor(options: BridgeOptions) {
    this.options = {
      now: () => Date.now(),
      reconnect: { initialMs: 500, maxMs: 15_000 },
      tools: 'dynamic',
      briefing: false,
      ...options,
    };
    this.named = options.slot === undefined;
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
            text: 'Join the Round Table. Call join_request with a short name for yourself; if that name is already paired you are back in at once, otherwise show me the match phrase and wait for me to paste the code. After that the Round Table drives this session: follow the "[Round Table] next" line on every result and keep working through its tools.',
          },
        }],
      }),
    );
    if (options.slot !== undefined) this.sessions.set(options.slot, this.newSession(assertSlot(options.slot)));
    this.applyTools();
  }

  /** Connects the fixed-slot agent (rejoining if it has an identity), then serves MCP on `transport`. */
  async start(transport: McpTransport): Promise<void> {
    for (const session of this.sessions.values()) await session.connectOrRetry();
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    await this.server.close();
  }

  /** Role of the only agent (tests and logs); 'fenced' once replaced. */
  get currentRole(): Role | 'fenced' {
    const only = [...this.sessions.values()][0];
    if (!only) return 'unpaired';
    return only.fenced ? 'fenced' : only.role;
  }

  private newSession(slot: string): AgentSession {
    return new AgentSession({
      slot,
      connector: this.options.connector,
      keyStore: this.options.keyStore,
      clientName: this.options.clientName,
      waitMaxMs: this.options.waitMaxMs,
      briefing: this.options.briefing,
      now: this.options.now,
      reconnect: this.options.reconnect,
      log: (m) => this.options.log?.(m),
      onChange: () => this.applyTools(),
    });
  }

  // ── tools ─────────────────────────────────────────────────────────────────────────────

  private register(def: ProcedureDef): void {
    const hidden = new Set([...(FILLED[def.name] ?? []), 'projectId']);
    const shape = (def.input as z.ZodObject).shape;
    const fields: Record<string, z.ZodType> = Object.fromEntries(Object.entries(shape).filter(([key]) => !hidden.has(key)));
    // Several agents may share this server: every call but join_request says who is calling.
    if (this.named && def.name !== 'join_request') fields.as = AS_FIELD;
    const tool = this.server.registerTool(
      def.name,
      { description: TOOL_DESCRIPTIONS[def.name] ?? describe(def), inputSchema: z.object(fields) },
      async (args: Record<string, unknown>) => this.call(def.name, args),
    );
    this.tools.set(def.name, tool);
  }

  /**
   * Which tools the model sees. Per-role lists (tools/list_changed) only make sense for one agent
   * per server; with names, or in static mode, every tool stays listed and the hub enforces roles.
   */
  private applyTools(): void {
    let visible: Set<string>;
    const only = [...this.sessions.values()][0];
    if (this.named || this.options.tools === 'static') visible = new Set(this.tools.keys());
    else if (!only || only.fenced) visible = new Set();
    else if (only.role !== 'unpaired') visible = new Set(mcpToolsFor(only.role as PrincipalKind).map((p) => p.name));
    else if (only.identity) visible = new Set(['rejoin']);
    else visible = new Set(['join_request', 'join_confirm']);
    for (const [name, tool] of this.tools) {
      if (visible.has(name) && !tool.enabled) tool.enable();
      if (!visible.has(name) && tool.enabled) tool.disable();
    }
  }

  private async call(name: string, rawArgs: Record<string, unknown>) {
    const { as, ...args } = rawArgs;
    const picked = await this.pick(name, args, typeof as === 'string' ? as : undefined);
    if ('error' in picked) return { content: [{ type: 'text' as const, text: `${STATUS_PREFIX} ${name} failed (${picked.error})` }], isError: true };
    const out = await picked.session.handle(name, args);
    return { content: [{ type: 'text' as const, text: out.text }], ...(out.isError && { isError: true }) };
  }

  /** The agent a call belongs to. With a fixed slot there is one; with names, `as` or the only one. */
  private async pick(name: string, args: Record<string, unknown>, as: string | undefined): Promise<{ session: AgentSession } | { error: string }> {
    if (!this.named) return { session: [...this.sessions.values()][0]! };

    if (name === 'join_request') {
      const slot = slotForName(String(args.name ?? ''));
      return { session: await this.ensure(slot) };
    }
    if (as !== undefined) {
      const slot = slotForName(as);
      const known = this.sessions.get(slot);
      if (known) return { session: known };
      // A restarted server: the name may have an identity or a pending request on disk.
      if (name === 'join_confirm' || name === 'rejoin') return { session: await this.ensure(slot) };
      return { error: `no agent named "${as}" has joined through this server yet: call join_request with name "${as}" first` };
    }
    const all = [...this.sessions.values()];
    if (all.length === 1) return { session: all[0]! };
    if (all.length > 1) {
      return { error: `several agents use this server (${all.map((s) => s.slot).join(', ')}): pass as with your Round Table name` };
    }
    if (name === 'join_confirm') {
      // Restarted between join_request and the code: find the pending request on disk.
      const slot = await this.onlyPendingSlot();
      if (slot) return { session: await this.ensure(slot) };
    }
    return { error: 'not joined yet: call join_request with your name first' };
  }

  private async ensure(slot: string): Promise<AgentSession> {
    let session = this.sessions.get(slot);
    if (!session) {
      session = this.newSession(slot);
      this.sessions.set(slot, session);
      await session.connectOrRetry();
    }
    return session;
  }

  private async onlyPendingSlot(): Promise<string | undefined> {
    // Only needs the hub id, so a bare connection: never authenticate anyone here.
    const client = await this.options.connector.connect('agent').then((t) => new HubClient(t)).catch(() => undefined);
    if (!client) return undefined;
    try {
      const { hubId } = await client.call<{ hubId: string }>('hub.info');
      const slots = await this.options.keyStore.listPending(hubId);
      return slots.length === 1 ? slots[0] : undefined;
    } catch {
      return undefined;
    } finally {
      client.close();
    }
  }
}
