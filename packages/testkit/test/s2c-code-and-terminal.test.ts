import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHttpServer, Hub, MemorySecretStore } from '@round-table/hub';
import { generateIdentityKey } from '@round-table/protocol/crypto';
import { SampleRepo, TestHub } from '../src/index.ts';

let t: TestHub | undefined;
let repo: SampleRepo | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  repo?.dispose();
});

describe('read-only git for the human (S2c)', () => {
  it('shows branches with ahead/behind and their task, history, a commit, a branch diff, worktrees and files', async () => {
    t = await TestHub.start();
    repo = new SampleRepo();
    const { projectId } = await t.human.call<{ projectId: string }>('project.create', { name: 'P' });
    await t.human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
    const wt = repo.worktree();
    wt.branch('rt/feature');
    const sha = wt.commit('greeting.txt', 'hello there\n', 'say hello there');

    const { branches } = await t.human.call<{ branches: Array<{ name: string; ahead: number; behind: number; last: { subject: string } }> }>('git.branches', { projectId });
    expect(branches.find((b) => b.name === 'rt/feature')).toMatchObject({ ahead: 1, behind: 0, last: { subject: 'say hello there' } });

    const { commits } = await t.human.call<{ commits: Array<{ sha: string; subject: string; refs: string[] }> }>('git.log', { projectId });
    expect(commits[0]).toMatchObject({ sha, subject: 'say hello there' });

    const shown = await t.human.call<{ files: Array<{ path: string; added: number }>; patch: string }>('git.show', { projectId, sha });
    expect(shown.files).toEqual([{ path: 'greeting.txt', added: 1, removed: 1 }]);
    expect(shown.patch).toContain('+hello there');

    const d = await t.human.call<{ commits: unknown[]; patch: string }>('git.diff', { projectId, base: 'main', head: 'rt/feature' });
    expect(d.commits).toHaveLength(1);
    expect(d.patch).toContain('-hello');

    const { worktrees } = await t.human.call<{ worktrees: Array<{ path: string; branch: string | null; changes: unknown[] }> }>('git.worktrees', { projectId });
    expect(worktrees.map((w) => w.branch)).toContain('rt/feature');
    expect(worktrees.some((w) => w.path === repo!.path)).toBe(true);

    const file = await t.human.call<{ text: string }>('git.file', { projectId, ref: 'rt/feature', path: 'greeting.txt' });
    expect(file.text).toBe('hello there\n');
    const { entries } = await t.human.call<{ entries: Array<{ name: string; kind: string }> }>('git.tree', { projectId, path: '' });
    expect(entries.map((e) => e.name)).toContain('greeting.txt');

    // Refs and paths can't become options or leave the repository; worktrees must be the repo's.
    await expect(t.human.call('git.log', { projectId, ref: '--output=/tmp/x' })).rejects.toThrow(/not a ref/);
    await expect(t.human.call('git.file', { projectId, path: '../etc/passwd' })).rejects.toThrow(/inside/);
    await expect(t.human.call('git.tree', { projectId, worktree: '/etc' })).rejects.toThrow(/not a worktree/);
  });
});

describe('the human’s terminal (S2c, ADR-0021)', () => {
  let hub: Hub | undefined;
  let close: (() => Promise<void>) | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await close?.();
    hub = undefined;
  });

  async function start() {
    const dir = mkdtempSync(join(tmpdir(), 'rt-term-'));
    hub = new Hub({ storePath: join(dir, 'hub.db'), hubKey: generateIdentityKey(), secrets: new MemorySecretStore() });
    const http = createHttpServer(hub);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const port = (http.address() as AddressInfo).port;
    close = async () => {
      hub!.close();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
      rmSync(dir, { recursive: true, force: true });
    };
    return port;
  }

  function open(port: number, query: string, cookie?: string): Promise<{ ws: WebSocket; out: () => string; status: Promise<number | 'open'> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}`, { headers: cookie ? { cookie: `rt_session=${cookie}` } : {} });
    sockets.push(ws);
    ws.on('error', () => {}); // a refused handshake closes it; the status says why
    let text = '';
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; data?: string; message?: string };
      text += m.type === 'output' ? m.data : m.type === 'error' ? `ERROR ${m.message}` : '';
    });
    const status = new Promise<number | 'open'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
    return Promise.resolve({ ws, out: () => text, status });
  }

  it('runs a shell in the project’s repository for a logged-in human', async () => {
    const port = await start();
    repo = new SampleRepo();
    const human = hub!.createHumanSession();
    const projectId = (hub!.bus.dispatch('project.create', { name: 'P' }, { kind: 'human', humanId: 'h' }) as { ok: true; output: { projectId: string } }).output.projectId;
    hub!.bus.dispatch('repo.attach', { projectId, path: repo.path, mainBranch: 'main' }, { kind: 'human', humanId: 'h' });
    expect(hub!.model.projects[projectId as never]?.repoId).toBeTruthy();
    const term = await open(port, `projectId=${projectId}&cols=80&rows=24`, human);
    expect(await term.status).toBe('open');
    // Type once the shell has drawn its prompt, as a person would.
    await expect.poll(() => term.out().length, { timeout: 15_000 }).toBeGreaterThan(0);
    term.ws.send(JSON.stringify({ type: 'input', data: 'echo rt-$((40+2)); pwd\n' }));
    await expect.poll(() => term.out(), { timeout: 15_000, message: 'the shell answers' }).toContain('rt-42');
    expect(term.out()).toContain(repo.path);
    term.ws.close();
  }, 30_000);

  it('refuses without the human’s login, and when the setting turns it off', async () => {
    const port = await start();
    const anon = await open(port, 'projectId=x');
    expect(await anon.status).toBe(403);
    const human = hub!.createHumanSession();
    hub!.bus.dispatch('settings.set', { scope: 'hub', overrides: { tools: { terminal: false } } }, { kind: 'human', humanId: 'h' });
    const off = await open(port, 'projectId=x', human);
    expect(await off.status).toBe(403);
  });
});
