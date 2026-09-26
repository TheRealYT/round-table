import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentBridge, type BridgeOptions } from './bridge.ts';

/** Runs rt-agent on stdio, as an agent's MCP client starts it. Logs go to stderr; stdout is MCP only. */
export async function runAgentStdio(options: Omit<BridgeOptions, 'log'>): Promise<AgentBridge> {
  const bridge = new AgentBridge({ ...options, log: (m) => process.stderr.write(`${m}\n`) });
  await bridge.start(new StdioServerTransport());
  const stop = () => void bridge.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('close', stop);
  return bridge;
}
