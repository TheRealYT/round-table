// S0 spike: how does a real MCP client (Claude Code) treat long tool calls, progress and list_changed?
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';

const LOG = process.env.SPIKE_LOG ?? "/tmp/spike-s0.log";
const log = (msg) => appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);

const server = new McpServer({ name: 'spike', version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } });

server.registerTool('sleep', {
  description: 'Sleeps for the given seconds, then returns. If progress=true, sends a progress notification every 10 s.',
  inputSchema: { seconds: z.number(), progress: z.boolean() },
}, async ({ seconds, progress }, extra) => {
  const token = extra._meta?.progressToken;
  log(`sleep start seconds=${seconds} progress=${progress} progressToken=${JSON.stringify(token)}`);
  const started = Date.now();
  let timer;
  if (progress && token !== undefined) {
    let n = 0;
    timer = setInterval(() => {
      n += 1;
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: n, message: 'waiting' } })
        .then(() => log(`progress ${n} sent`), (e) => log(`progress ${n} failed ${e}`));
    }, 10_000);
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, seconds * 1000);
    extra.signal.addEventListener('abort', () => { clearTimeout(t); log(`sleep ABORTED after ${Date.now() - started} ms: ${extra.signal.reason}`); reject(new Error('aborted')); });
  });
  if (timer) clearInterval(timer);
  log(`sleep done after ${Date.now() - started} ms`);
  return { content: [{ type: 'text', text: `slept ${seconds}s ⟪inbox: 1 human (call wait now)⟫` }] };
});

const leaderTool = server.registerTool('leader_only', {
  description: 'A tool that only appears after become_leader is called.',
  inputSchema: {},
}, async () => {
  log('leader_only called');
  return { content: [{ type: 'text', text: 'LEADER TOOL WORKS' }] };
});
leaderTool.disable();

server.registerTool('become_leader', {
  description: 'Makes this session the leader. New tools become available afterwards.',
  inputSchema: {},
}, async () => {
  leaderTool.enable(); // SDK sends notifications/tools/list_changed
  log('become_leader: enabled leader_only, list_changed sent');
  return { content: [{ type: 'text', text: 'You are the leader now. A new tool, leader_only, is available: call it.' }] };
});

server.server.oninitialized = () => log(`initialized; client=${JSON.stringify(server.server.getClientVersion())} caps=${JSON.stringify(server.server.getClientCapabilities())}`);
await server.connect(new StdioServerTransport());
log('server started');
