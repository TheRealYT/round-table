import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Any MCP client can run rt-agent (ADR-0014). A profile says how to install rt-agent into that
 * client's per-project config and what rt-agent may rely on. Anything not verified against the
 * real client falls back to the safe choice: a wait under the 60 s default tool timeout, a static
 * tool list, and a briefing in tool results instead of relying on server instructions.
 */
export type ClientId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'vscode' | 'generic';

export interface ServerLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ClientProfile {
  id: ClientId;
  name: string;
  /**
   * What was checked against the real client (2026-09-26): 'config' means the client lists the
   * server from the file we write; 'runtime' means timeouts, list_changed and instructions were
   * exercised in a real session. Anything else comes from the client's documentation.
   */
  verified: 'runtime' | 'config' | 'docs';
  /** The tool timeout `install` configures, or null if the client has no per-server setting we know. */
  toolTimeoutMs: number | null;
  /** Longest wait rt-agent uses for this client: below the tool timeout. */
  waitMaxMs: number;
  /** tools/list_changed is known to work: tools appear per role. Otherwise all tools stay listed. */
  dynamicTools: boolean;
  /** MCP server instructions are known to reach the model. Otherwise rt-agent adds a briefing to results. */
  instructions: boolean;
  /** Writes the config and returns the files and what the human still has to do. */
  install(dir: string, server: ServerLaunch): { files: string[]; notes: string[] };
}

/** Default MCP request timeout of the reference SDK, which most clients keep (S0 finding 1). */
const SAFE_WAIT_MS = 50_000;
const RAISED_TIMEOUT_MS = 300_000;
const RAISED_WAIT_MS = 240_000;

export const CLIENTS: Record<ClientId, ClientProfile> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    verified: 'runtime',
    toolTimeoutMs: RAISED_TIMEOUT_MS,
    waitMaxMs: RAISED_WAIT_MS,
    dynamicTools: true,
    instructions: true,
    install(dir, server) {
      const mcpPath = join(dir, '.mcp.json');
      updateJson(mcpPath, (mcp) => ({ ...mcp, mcpServers: { ...(mcp.mcpServers as object), roundtable: stdio(server) } }));
      const settingsPath = join(dir, '.claude', 'settings.local.json');
      updateJson(settingsPath, (s) => ({
        ...s,
        env: { ...(s.env as object), MCP_TOOL_TIMEOUT: String(RAISED_TIMEOUT_MS) },
        enabledMcpjsonServers: [...new Set([...((s.enabledMcpjsonServers as string[] | undefined) ?? []), 'roundtable'])],
      }));
      return { files: [mcpPath, settingsPath], notes: [`cd ${dir} && claude, then run /mcp__roundtable__join or say "join the Round Table".`] };
    },
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    verified: 'config',
    toolTimeoutMs: RAISED_TIMEOUT_MS,
    waitMaxMs: RAISED_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(dir, server) {
      const path = join(dir, '.codex', 'config.toml');
      const block = [
        '[mcp_servers.roundtable]',
        `command = ${toml(server.command)}`,
        `args = [${server.args.map(toml).join(', ')}]`,
        ...(server.env ? [`env = { ${Object.entries(server.env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`] : []),
        'startup_timeout_sec = 30',
        `tool_timeout_sec = ${RAISED_TIMEOUT_MS / 1000}`,
      ].join('\n');
      writeText(path, replaceTomlTable(readText(path), 'mcp_servers.roundtable', block));
      return {
        files: [path],
        notes: [
          'Codex reads a project .codex/config.toml only for trusted projects: accept the trust prompt on first run,',
          `or add to ~/.codex/config.toml:  [projects.${toml(dir)}]  trust_level = "trusted"`,
          `Then: cd ${dir} && codex, and say "join the Round Table".`,
        ],
      };
    },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    verified: 'config',
    toolTimeoutMs: RAISED_TIMEOUT_MS,
    waitMaxMs: RAISED_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(dir, server) {
      const path = join(dir, '.gemini', 'settings.json');
      updateJson(path, (s) => ({ ...s, mcpServers: { ...(s.mcpServers as object), roundtable: { ...stdio(server), timeout: RAISED_TIMEOUT_MS } } }));
      return {
        files: [path],
        notes: [
          'Gemini CLI disables project MCP servers in untrusted folders: trust this folder when it asks (or via /permissions).',
          `Then: cd ${dir} && gemini, and say "join the Round Table".`,
        ],
      };
    },
  },
  opencode: {
    id: 'opencode',
    name: 'opencode',
    verified: 'config',
    toolTimeoutMs: null,
    waitMaxMs: SAFE_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(dir, server) {
      const path = join(dir, 'opencode.json');
      updateJson(path, (s) => ({
        $schema: 'https://opencode.ai/config.json',
        ...s,
        mcp: {
          ...(s.mcp as object),
          roundtable: { type: 'local', command: [server.command, ...server.args], enabled: true, ...(server.env && { environment: server.env }) },
        },
      }));
      return { files: [path], notes: [`cd ${dir} && opencode, and say "join the Round Table".`] };
    },
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    verified: 'docs',
    toolTimeoutMs: null,
    waitMaxMs: SAFE_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(dir, server) {
      const path = join(dir, '.cursor', 'mcp.json');
      updateJson(path, (s) => ({ ...s, mcpServers: { ...(s.mcpServers as object), roundtable: stdio(server) } }));
      return { files: [path], notes: ['Open the folder in Cursor, enable the roundtable server in MCP settings, and ask the agent to join the Round Table.'] };
    },
  },
  vscode: {
    id: 'vscode',
    name: 'VS Code (agent mode)',
    verified: 'docs',
    toolTimeoutMs: null,
    waitMaxMs: SAFE_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(dir, server) {
      const path = join(dir, '.vscode', 'mcp.json');
      updateJson(path, (s) => ({ ...s, servers: { ...(s.servers as object), roundtable: { type: 'stdio', ...stdio(server) } } }));
      return { files: [path], notes: ['Open the folder in VS Code, start the roundtable server from .vscode/mcp.json, and ask the agent to join the Round Table.'] };
    },
  },
  generic: {
    id: 'generic',
    name: 'Any MCP client',
    verified: 'docs',
    toolTimeoutMs: null,
    waitMaxMs: SAFE_WAIT_MS,
    dynamicTools: false,
    instructions: false,
    install(_dir, server) {
      return {
        files: [],
        notes: ['Add this stdio server to your MCP client:', JSON.stringify({ roundtable: stdio(server) }, null, 2)],
      };
    },
  },
};

export function clientProfile(id: string): ClientProfile {
  const profile = CLIENTS[id as ClientId];
  if (!profile) throw new Error(`unknown client "${id}"; use one of: ${Object.keys(CLIENTS).join(', ')}`);
  return profile;
}

function stdio(server: ServerLaunch) {
  return { command: server.command, args: server.args, ...(server.env && { env: server.env }) };
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function updateJson(path: string, change: (value: Record<string, unknown>) => Record<string, unknown>): void {
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  writeText(path, `${JSON.stringify(change(current), null, 2)}\n`);
}

function toml(value: string): string {
  return JSON.stringify(value); // TOML basic strings share JSON's escaping for what we write
}

/** Replaces one `[table]` (and its sub-tables) in a TOML document, or appends it. */
export function replaceTomlTable(document: string, table: string, block: string): string {
  const lines = document.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)?.[1]?.trim();
    if (header !== undefined) skipping = header === table || header.startsWith(`${table}.`);
    if (!skipping) out.push(line);
  }
  const kept = out.join('\n').trimEnd();
  return `${kept ? `${kept}\n\n` : ''}${block}\n`;
}
