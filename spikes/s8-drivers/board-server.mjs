#!/usr/bin/env node
// A dependency-free MCP stdio server standing in for the Round Table hub in the CLI check.
// One tool, `report`, appends what the agent says to $BOARD_LOG, so the check can see that the
// CLI loaded our MCP server and called it, without parsing the CLI's own output.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Where calls are recorded: $BOARD_LOG, or the first argument (for CLIs that can't pass env to MCP servers).
const log = process.env.BOARD_LOG || process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const TOOLS = [
  {
    name: 'report',
    description: 'Report progress to the Round Table hub.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What you did.' } }, required: ['text'] },
  },
  {
    name: 'fetch_plan',
    description: 'Fetch the team plan from the Round Table hub. It takes about 90 seconds to answer.',
    inputSchema: { type: 'object', properties: {} },
  },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      return send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'board', version: '0' },
          instructions: 'The Round Table hub. Report progress with the report tool.',
        },
      });
    case 'tools/list':
      return send({ id: msg.id, result: { tools: TOOLS } });
    case 'tools/call': {
      if (msg.params?.name === 'fetch_plan') {
        // Slow on purpose: the check interrupts the CLI while it waits here.
        if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), text: 'fetch_plan started' })}\n`);
        setTimeout(() => send({ id: msg.id, result: { content: [{ type: 'text', text: 'The plan: nothing to do.' }] } }), 90_000);
        return;
      }
      const text = String(msg.params?.arguments?.text ?? '');
      if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), text })}\n`);
      return send({ id: msg.id, result: { content: [{ type: 'text', text: 'recorded' }] } });
    }
    case 'ping':
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
