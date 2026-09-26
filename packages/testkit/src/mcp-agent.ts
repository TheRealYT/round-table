import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentBridge, MemoryKeyStore, type KeyStore } from '@round-table/agent';
import type { TestHub } from './test-hub.ts';

/**
 * An rt-agent driven by a real MCP client, as a model's client would drive it. Tests see exactly
 * what the model sees: tool lists, tool result text, and list_changed notifications.
 */
export class McpAgent {
  readonly bridge: AgentBridge;
  readonly client: Client;
  readonly keyStore: KeyStore;
  listChanged = 0;

  private constructor(bridge: AgentBridge, client: Client, keyStore: KeyStore) {
    this.bridge = bridge;
    this.client = client;
    this.keyStore = keyStore;
  }

  static async start(t: TestHub, options: { /** null: no fixed slot, agents are identified by join name */ slot?: string | null; keyStore?: KeyStore; waitMaxMs?: number; tools?: 'dynamic' | 'static'; briefing?: boolean } = {}): Promise<McpAgent> {
    const keyStore = options.keyStore ?? new MemoryKeyStore();
    const bridge = new AgentBridge({
      ...(options.slot !== null && { slot: options.slot ?? 'a' }),
      connector: t.network,
      keyStore,
      clientName: 'test-client',
      waitMaxMs: options.waitMaxMs ?? 1_000,
      now: () => t.clock.now(),
      reconnect: { initialMs: 10, maxMs: 50 },
      ...(options.tools && { tools: options.tools }),
      ...(options.briefing !== undefined && { briefing: options.briefing }),
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const agent = new McpAgent(bridge, client, keyStore);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      agent.listChanged += 1;
    });
    await bridge.start(serverSide);
    await client.connect(clientSide);
    return agent;
  }

  async tools(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name).sort();
  }

  /** Calls a tool and returns its text; `isError` results come back with an `ERROR ` prefix. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    return result.isError ? `ERROR ${text}` : text;
  }

  async instructions(): Promise<string | undefined> {
    return this.client.getInstructions();
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.bridge.close();
  }
}
