// A stand-in for the hub's MCP tools: report() records what the agent says, idle() tells it to end its turn.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = process.env.BOARD_LOG;
const server = new McpServer({ name: 'board', version: '0' }, { instructions: 'The Round Table hub. Report progress with report. When you have nothing left to do, end your turn: the hub resumes you with the next message.' });
server.registerTool('report', { description: 'Report progress to the hub.', inputSchema: { text: z.string() } }, async ({ text }) => {
  appendFileSync(log, JSON.stringify({ at: Date.now(), text }) + '\n');
  return { content: [{ type: 'text', text: 'recorded' }] };
});
await server.connect(new StdioServerTransport());
