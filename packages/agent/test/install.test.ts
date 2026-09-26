import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENTS, installAgent, replaceTomlTable } from '../src/index.ts';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const base = { slot: 'worker-a', hubUrl: 'ws://127.0.0.1:7777', command: ['/usr/bin/node', '/rt/main.ts'] as [string, ...string[]] };
const args = ['/rt/main.ts', 'agent', 'run', '--slot', 'worker-a', '--hub', 'ws://127.0.0.1:7777', '--client'];
const read = (...p: string[]) => readFileSync(join(dir, ...p), 'utf8');

describe('rt agent install', () => {
  it('claude-code: adds the server and raises the tool timeout, keeping existing settings', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ env: { FOO: '1' }, enabledMcpjsonServers: ['other'] }));
    installAgent({ ...base, client: 'claude-code', dir });
    installAgent({ ...base, client: 'claude-code', dir });
    const mcp = JSON.parse(read('.mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['other', 'roundtable']);
    expect(mcp.mcpServers.roundtable).toEqual({ command: '/usr/bin/node', args: [...args, 'claude-code'] });
    const settings = JSON.parse(read('.claude', 'settings.local.json'));
    expect(settings.env).toEqual({ FOO: '1', MCP_TOOL_TIMEOUT: '300000' });
    expect(settings.enabledMcpjsonServers).toEqual(['other', 'roundtable']);
  });

  it('codex: writes a project .codex/config.toml table with a raised tool timeout, replacing only its own table', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    mkdirSync(join(dir, '.codex'));
    writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
    installAgent({ ...base, client: 'codex', dir, env: { RT_HOME: '/h' } });
    const { notes } = installAgent({ ...base, client: 'codex', dir, env: { RT_HOME: '/h' } });
    const text = read('.codex', 'config.toml');
    expect(text.match(/\[mcp_servers\.roundtable\]/g)).toHaveLength(1);
    expect(text).toContain('model = "o3"');
    expect(text).toContain('[mcp_servers.other]');
    expect(text).toContain('tool_timeout_sec = 300');
    expect(text).toContain('env = { RT_HOME = "/h" }');
    expect(text).toContain(`args = [${[...args, 'codex'].map((a) => JSON.stringify(a)).join(', ')}]`);
    expect(notes.join('\n')).toContain('trust');
  });

  it('gemini, opencode, cursor and vscode: write each client\'s project MCP file', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    installAgent({ ...base, client: 'gemini', dir });
    installAgent({ ...base, client: 'opencode', dir });
    installAgent({ ...base, client: 'cursor', dir });
    installAgent({ ...base, client: 'vscode', dir });
    expect(JSON.parse(read('.gemini', 'settings.json')).mcpServers.roundtable).toEqual({ command: '/usr/bin/node', args: [...args, 'gemini'], timeout: 300000 });
    expect(JSON.parse(read('opencode.json')).mcp.roundtable).toEqual({ type: 'local', command: ['/usr/bin/node', ...args, 'opencode'], enabled: true });
    expect(JSON.parse(read('.cursor', 'mcp.json')).mcpServers.roundtable.args).toEqual([...args, 'cursor']);
    expect(JSON.parse(read('.vscode', 'mcp.json')).servers.roundtable).toMatchObject({ type: 'stdio', command: '/usr/bin/node' });
  });

  it('keeps every client within its tool timeout, and only trusts dynamic tools where verified at runtime', () => {
    for (const p of Object.values(CLIENTS)) {
      expect(p.waitMaxMs).toBeLessThan(p.toolTimeoutMs ?? 60_000);
      if (p.dynamicTools || p.instructions) expect(p.verified).toBe('runtime');
    }
  });

  it('refuses unknown clients and slot names that could escape paths', () => {
    dir = mkdtempSync(join(tmpdir(), 'rt-install-'));
    expect(() => installAgent({ ...base, client: 'nope', dir })).toThrow(/unknown client/);
    expect(() => installAgent({ ...base, slot: '../x', client: 'codex', dir })).toThrow();
  });

  it('replaces a TOML table with its sub-tables', () => {
    const doc = 'a = 1\n[t]\nx = 1\n[t.env]\nY = "2"\n[u]\nz = 3\n';
    expect(replaceTomlTable(doc, 't', '[t]\nx = 9')).toBe('a = 1\n[u]\nz = 3\n\n[t]\nx = 9\n');
  });
});

describe('agent worktrees', () => {
  it('creates a detached worktree per agent and keeps client config out of commits', async () => {
    const { execFileSync } = await import('node:child_process');
    const { createAgentWorktree } = await import('../src/index.ts');
    dir = mkdtempSync(join(tmpdir(), 'rt-wt-'));
    const repo = join(dir, 'repo');
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'init');
    const wt = join(dir, 'agent-a');
    expect(createAgentWorktree(repo, wt).created).toBe(true);
    expect(createAgentWorktree(repo, wt).created).toBe(false);
    expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    installAgent({ ...base, client: 'claude-code', dir: wt });
    expect(g(wt, 'status', '--porcelain')).toBe('');
    expect(() => createAgentWorktree(repo, repo)).toThrow();
  });
});
