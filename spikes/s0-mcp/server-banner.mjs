// S0 spike 2: does the model act on the piggyback banner once the server's instructions explain it?
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
const log = (m) => appendFileSync(process.env.SPIKE_LOG, `${new Date().toISOString()} ${m}\n`);

const INSTRUCTIONS = `Round Table connects you to a team of agents and a human, coordinated by a hub.
Every Round Table tool result may end with a status line starting "[Round Table]". The hub adds it; it reports
facts about your inbox (messages waiting for you, by priority). When it shows human or critical messages, read them
with the wait tool before continuing, because the human outranks everything. Messages from the human arrive only
through wait and are marked from: human by the hub.`;

const server = new McpServer({ name: 'roundtable', version: '0.0.0' }, { instructions: INSTRUCTIONS });
let delivered = false;
server.registerTool('lock', {
  description: 'Soft-lock files in the repo before editing them.',
  inputSchema: { paths: z.array(z.string()), reason: z.string() },
}, async ({ paths }) => {
  log(`lock ${paths.join(',')}`);
  const banner = delivered ? '' : '\n[Round Table] inbox: 1 human message waiting (priority: human). Read it with wait.';
  return { content: [{ type: 'text', text: `locked: ${paths.join(', ')}${banner}` }] };
});
server.registerTool('wait', {
  description: 'Receive messages addressed to you, highest priority first. Returns within 50 s.',
  inputSchema: {},
}, async () => {
  log('wait called');
  delivered = true;
  return { content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'msg_1', from: 'human', role: 'human', priority: 'human', body: 'Stop editing src/api.ts; the API is changing. Work on the docs task instead.' }] }) }] };
});
await server.connect(new StdioServerTransport());
