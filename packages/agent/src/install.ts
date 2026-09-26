import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSlot } from './identity.ts';

/** S0: Claude Code aborts tool calls at 60 s unless MCP_TOOL_TIMEOUT raises it. */
export const INSTALL_TOOL_TIMEOUT_MS = 300_000;
export const INSTALL_WAIT_MAX_MS = 240_000;

export interface InstallOptions {
  dir: string;
  slot: string;
  hubUrl: string;
  /** How to start the rt command: `[node, /path/to/cli/src/main.ts]`. */
  command: [string, ...string[]];
  /** Extra environment for rt-agent (e.g. a custom RT_HOME); MCP clients may not pass theirs through. */
  env?: Record<string, string>;
}

/**
 * Sets up a Claude Code working directory for one agent slot (architecture §2, `rt agent install`):
 * `.mcp.json` starts rt-agent for the slot, and `.claude/settings.local.json` raises the MCP tool
 * timeout and pre-approves the server. Existing settings are merged, not replaced.
 */
export function installClaudeCode(options: InstallOptions): { files: string[] } {
  assertSlot(options.slot);
  const [command, ...prefix] = options.command;
  const mcpPath = join(options.dir, '.mcp.json');
  const mcp = readJson(mcpPath) as { mcpServers?: Record<string, unknown> };
  mcp.mcpServers = {
    ...mcp.mcpServers,
    roundtable: {
      command,
      args: [...prefix, 'agent', 'run', '--slot', options.slot, '--hub', options.hubUrl, '--client', 'claude-code', '--wait-max-ms', String(INSTALL_WAIT_MAX_MS)],
      ...(options.env && Object.keys(options.env).length > 0 && { env: options.env }),
    },
  };
  writeJson(mcpPath, mcp);

  const settingsPath = join(options.dir, '.claude', 'settings.local.json');
  const settings = readJson(settingsPath) as { env?: Record<string, string>; enabledMcpjsonServers?: string[] };
  settings.env = { ...settings.env, MCP_TOOL_TIMEOUT: String(INSTALL_TOOL_TIMEOUT_MS) };
  settings.enabledMcpjsonServers = [...new Set([...(settings.enabledMcpjsonServers ?? []), 'roundtable'])];
  mkdirSync(join(options.dir, '.claude'), { recursive: true });
  writeJson(settingsPath, settings);
  return { files: [mcpPath, settingsPath] };
}

function readJson(path: string): Record<string, unknown> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
