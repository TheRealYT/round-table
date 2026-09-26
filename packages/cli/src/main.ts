#!/usr/bin/env node
// The `rt` command (architecture §2). Subcommands arrive slice by slice (docs/architecture/build-plan.md).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { demo } from './demo.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLIENTS, clientProfile, createAgentWorktree, FileKeyStore, installAgent, rtHome, runAgentStdio } from '@round-table/agent';
import { createHttpServer, Hub, loadOrCreateHubKey } from '@round-table/hub';
import { WsConnector, WsListener } from '@round-table/protocol/ws';
import { randomToken } from '@round-table/protocol/crypto';

const DEFAULT_PORT = 7777;
const APP_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/dist');
const MAIN = fileURLToPath(import.meta.url);

const COMMANDS: Record<string, { slice: string; usage: string; summary: string }> = {
  'hub start': { slice: 'S1', usage: '[--port 7777] [--data <dir>] [--app <dir>]', summary: 'Start the hub on 127.0.0.1 and print the one-time login URL.' },
  'hub login': { slice: 'S1', usage: '', summary: 'Print a new one-time login link for the running hub.' },
  demo: { slice: 'S1', usage: '[--dir <path>] [--client <id>] [--agents lead,ada,bo]', summary: 'Create a sample repo and one worktree per agent, installed for a client, and print what to do next.' },
  'agent run': { slice: 'S1', usage: '[--slot <name>] [--client <id>] [--hub <url>] [--wait-max-ms <n>] [--tools dynamic|static]', summary: 'Run rt-agent on stdio (what an agent\'s MCP client starts).' },
  'agent install': { slice: 'S1', usage: '--client <id> [--slot <name>] [--dir <path>] [--repo <path> [--main <branch>]] [--hub <url>]', summary: `Write <dir>'s MCP config for a client so it runs rt-agent. Clients: ${Object.keys(CLIENTS).join(', ')}.` },
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
  /** 0600 file with the secret `rt hub login` uses to ask the running hub for a new login link. */
  adminSecretPath: string;
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
  const adminSecret = randomToken();
  const adminSecretPath = join(dataDir, 'admin-secret');
  writeFileSync(adminSecretPath, adminSecret, { mode: 0o600 });
  chmodSync(adminSecretPath, 0o600);
  const http = createHttpServer(hub, { appDir: values.app ?? APP_DIST, adminSecret });
  hub.listen(WsListener.attach(http));
  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', resolveListen);
  });
  const httpUrl = `http://127.0.0.1:${port}`;
  mkdirSync(rtHome(), { recursive: true, mode: 0o700 });
  writeFileSync(hubPointerPath(), JSON.stringify({ url: `ws://127.0.0.1:${port}`, httpUrl, hubId: hub.hubId, adminSecretPath } satisfies HubPointer, null, 2));
  console.log(`Round Table hub ${hub.hubId}`);
  console.log(`  data:  ${dataDir}`);
  console.log(`  agents connect to ws://127.0.0.1:${port}/agent`);
  console.log(`\nOpen the app (one-time link, valid 10 minutes; \`rt hub login\` prints a new one):\n  ${httpUrl}/login?t=${hub.createLoginToken()}\n`);
  const stop = () => {
    console.log('stopping hub');
    http.close();
    hub.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function hubLogin(): Promise<void> {
  const pointer = readHubPointer();
  if (!pointer || !existsSync(pointer.adminSecretPath)) throw new Error('no running hub found; start one with `rt hub start`');
  const secret = readFileSync(pointer.adminSecretPath, 'utf8').trim();
  const res = await fetch(`${pointer.httpUrl}/admin/login-link`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } }).catch(() => undefined);
  if (!res?.ok) throw new Error(`the hub at ${pointer.httpUrl} did not answer; is it running?`);
  const { path } = (await res.json()) as { path: string };
  console.log(`Open the app (one-time link, valid 10 minutes):\n  ${pointer.httpUrl}${path}`);
}

async function agentRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { slot: { type: 'string' }, hub: { type: 'string' }, client: { type: 'string' }, 'wait-max-ms': { type: 'string' }, tools: { type: 'string' } },
  });
  // Without --slot, each agent's identity comes from the name it joins with, so one server can carry
  // several agents (e.g. several chats of one IDE); with --slot, this server is exactly one agent.
  // Unknown clients get the generic profile: short waits, static tools, briefing in results (ADR-0014).
  const profile = clientProfile(values.client && values.client in CLIENTS ? values.client : 'generic');
  const tools = values.tools ?? (profile.dynamicTools ? 'dynamic' : 'static');
  if (tools !== 'dynamic' && tools !== 'static') throw new Error('--tools must be dynamic or static');
  const hubUrl = values.hub ?? readHubPointer()?.url ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
  await runAgentStdio({
    ...(values.slot !== undefined && { slot: values.slot }),
    connector: new WsConnector(hubUrl),
    keyStore: new FileKeyStore(rtHome()),
    clientName: values.client ?? 'mcp-client',
    waitMaxMs: Number(values['wait-max-ms'] ?? profile.waitMaxMs),
    tools,
    briefing: !profile.instructions,
  });
}

function agentInstall(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { client: { type: 'string' }, slot: { type: 'string' }, dir: { type: 'string' }, hub: { type: 'string' }, repo: { type: 'string' }, main: { type: 'string' } },
  });
  if (!values.client) throw new Error(`--client is required: ${Object.keys(CLIENTS).join(', ')}`);
  const dir = resolve(values.dir ?? '.');
  if (values.repo) {
    // One worktree per agent (spec: Code sharing), detached at main; client config files stay out of commits.
    const wt = createAgentWorktree(resolve(values.repo), dir, values.main ?? 'main');
    console.log(wt.created ? `Created worktree ${dir} (detached at ${values.main ?? 'main'})` : `Using existing worktree ${dir}`);
  }
  const hubUrl = values.hub ?? readHubPointer()?.url ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
  const env = process.env.RT_HOME ? { RT_HOME: process.env.RT_HOME } : undefined;
  const { profile, files, notes } = installAgent({ client: values.client, dir, ...(values.slot !== undefined && { slot: values.slot }), hubUrl, command: [process.execPath, MAIN], ...(env && { env }) });
  console.log(`Installed Round Table for ${profile.name}${values.slot ? `, slot "${values.slot}"` : ' (agents are identified by the name they join with)'}:`);
  for (const f of files) console.log(`  ${f}`);
  console.log('');
  for (const n of notes) console.log(n);
  const timeout = profile.toolTimeoutMs ? `tool timeout raised to ${profile.toolTimeoutMs / 1000} s` : 'client tool timeout unknown';
  console.log(`\n(wait returns within ${profile.waitMaxMs / 1000} s: ${timeout}; tools ${profile.dynamicTools ? 'follow the role' : 'are all listed, the hub enforces roles'}; setup ${profile.verified === 'docs' ? 'from the client docs, not yet verified' : `verified (${profile.verified})`})`);
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
    case 'hub login':
      await hubLogin();
      return 0;
    case 'demo':
      demo(args);
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
