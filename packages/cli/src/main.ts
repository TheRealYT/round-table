#!/usr/bin/env node
// The `rt` command (architecture §2). Subcommands arrive slice by slice (docs/architecture/build-plan.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FileKeyStore, installClaudeCode, INSTALL_WAIT_MAX_MS, rtHome, runAgentStdio } from '@round-table/agent';
import { createHttpServer, Hub, loadOrCreateHubKey } from '@round-table/hub';
import { WsConnector, WsListener } from '@round-table/protocol/ws';

const DEFAULT_PORT = 7777;
const APP_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/dist');
const MAIN = fileURLToPath(import.meta.url);

const COMMANDS: Record<string, { slice: string; usage: string; summary: string }> = {
  'hub start': { slice: 'S1', usage: '[--port 7777] [--data <dir>] [--app <dir>]', summary: 'Start the hub on 127.0.0.1 and print the one-time login URL.' },
  'agent run': { slice: 'S1', usage: '--slot <name> [--hub <url>] [--client <name>] [--wait-max-ms <n>]', summary: 'Run rt-agent on stdio (what an agent client starts).' },
  'agent install': { slice: 'S1', usage: '--slot <name> [--dir <path>] [--hub <url>]', summary: 'Write .mcp.json and .claude/settings.local.json so Claude Code in <dir> runs rt-agent.' },
  hook: { slice: 'S6', usage: 'pre-tool-use | post-tool-use', summary: 'Hook adapter entry point, called by the agent client.' },
  supervise: { slice: 'S4', usage: '', summary: 'Restart dead agent sessions (D3).' },
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  rt ${name} ${c.usage}\n      ${c.summary}${c.slice === 'S1' ? '' : ` [slice ${c.slice}]`}`);
  return ['Usage:', ...lines].join('\n');
}

interface HubPointer {
  url: string;
  httpUrl: string;
  hubId: string;
}

/** `rt hub start` writes where the hub listens, so `rt agent install` needs no flags. */
function hubPointerPath(): string {
  return join(rtHome(), 'hub.json');
}

function readHubPointer(): HubPointer | undefined {
  const path = hubPointerPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as HubPointer) : undefined;
}

async function hubStart(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { port: { type: 'string' }, data: { type: 'string' }, app: { type: 'string' } } });
  const port = Number(values.port ?? DEFAULT_PORT);
  const dataDir = resolve(values.data ?? join(rtHome(), 'hub'));
  const hub = new Hub({ storePath: join(dataDir, 'hub.db'), hubKey: loadOrCreateHubKey(dataDir) });
  const http = createHttpServer(hub, { appDir: values.app ?? APP_DIST });
  hub.listen(WsListener.attach(http));
  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', resolveListen);
  });
  const httpUrl = `http://127.0.0.1:${port}`;
  mkdirSync(rtHome(), { recursive: true, mode: 0o700 });
  writeFileSync(hubPointerPath(), JSON.stringify({ url: `ws://127.0.0.1:${port}`, httpUrl, hubId: hub.hubId } satisfies HubPointer, null, 2));
  console.log(`Round Table hub ${hub.hubId}`);
  console.log(`  data:  ${dataDir}`);
  console.log(`  agents connect to ws://127.0.0.1:${port}/agent`);
  console.log(`\nOpen the app (one-time link, valid 10 minutes):\n  ${httpUrl}/login?t=${hub.createLoginToken()}\n`);
  const stop = () => {
    console.log('stopping hub');
    http.close();
    hub.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function agentRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { slot: { type: 'string' }, hub: { type: 'string' }, client: { type: 'string' }, 'wait-max-ms': { type: 'string' } },
  });
  if (!values.slot) throw new Error('--slot is required');
  const hubUrl = values.hub ?? readHubPointer()?.url ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
  await runAgentStdio({
    slot: values.slot,
    connector: new WsConnector(hubUrl),
    keyStore: new FileKeyStore(rtHome()),
    clientName: values.client ?? 'mcp-client',
    waitMaxMs: Number(values['wait-max-ms'] ?? 50_000),
  });
}

function agentInstall(args: string[]): void {
  const { values } = parseArgs({ args, options: { slot: { type: 'string' }, dir: { type: 'string' }, hub: { type: 'string' } } });
  if (!values.slot) throw new Error('--slot is required');
  const dir = resolve(values.dir ?? '.');
  const hubUrl = values.hub ?? readHubPointer()?.url ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
  const env = process.env.RT_HOME ? { RT_HOME: process.env.RT_HOME } : undefined;
  const { files } = installClaudeCode({ dir, slot: values.slot, hubUrl, command: [process.execPath, MAIN], ...(env && { env }) });
  console.log(`Installed Round Table for slot "${values.slot}" in ${dir}:`);
  for (const f of files) console.log(`  ${f}`);
  console.log(`\nStart Claude Code there and run the join prompt:\n  cd ${dir} && claude\n  > /mcp__roundtable__join`);
  console.log(`(wait runs up to ${INSTALL_WAIT_MAX_MS / 1000} s; MCP_TOOL_TIMEOUT is raised to match)`);
}

async function main(argv: string[]): Promise<number> {
  const [group, sub, ...rest] = argv;
  const name = sub && COMMANDS[`${group} ${sub}`] ? `${group} ${sub}` : group;
  if (!name || !COMMANDS[name]) {
    console.log(usage());
    return argv.length === 0 ? 0 : 1;
  }
  const args = name.includes(' ') ? rest : [sub, ...rest].filter((a): a is string => a !== undefined);
  switch (name) {
    case 'hub start':
      await hubStart(args);
      return 0;
    case 'agent run':
      await agentRun(args);
      return 0;
    case 'agent install':
      agentInstall(args);
      return 0;
    default:
      console.error(`rt ${name}: not built yet (slice ${COMMANDS[name]?.slice}).`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`rt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
