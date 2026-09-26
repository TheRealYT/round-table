import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClaudeCode, INSTALL_TOOL_TIMEOUT_MS } from '../src/index.ts';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rt agent install (claude-code)', () => {
  it('adds the server and raises the tool timeout, keeping existing settings', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ env: { FOO: '1' }, enabledMcpjsonServers: ['other'] }));

    installClaudeCode({ dir, slot: 'worker-a', hubUrl: 'ws://127.0.0.1:7777', command: ['/usr/bin/node', '/rt/main.ts'] });
    installClaudeCode({ dir, slot: 'worker-a', hubUrl: 'ws://127.0.0.1:7777', command: ['/usr/bin/node', '/rt/main.ts'] });

    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['other', 'roundtable']);
    expect(mcp.mcpServers.roundtable).toEqual({
      command: '/usr/bin/node',
      args: ['/rt/main.ts', 'agent', 'run', '--slot', 'worker-a', '--hub', 'ws://127.0.0.1:7777', '--client', 'claude-code', '--wait-max-ms', '240000'],
    });
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.env).toEqual({ FOO: '1', MCP_TOOL_TIMEOUT: String(INSTALL_TOOL_TIMEOUT_MS) });
    expect(settings.enabledMcpjsonServers).toEqual(['other', 'roundtable']);
  });

  it('refuses slot names that could escape paths', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    expect(() => installClaudeCode({ dir, slot: '../x', hubUrl: 'ws://x', command: ['node'] })).toThrow();
  });
});
