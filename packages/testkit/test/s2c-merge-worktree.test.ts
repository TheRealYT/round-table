import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitHost } from '@round-table/hub';
import { SampleRepo } from '../src/index.ts';

let repo: SampleRepo | undefined;
let root: string | undefined;
afterEach(() => {
  repo?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('the hub’s merge worktree (S2c)', () => {
  it('is reused between merges: tracked files are reset, installed (ignored) files stay', async () => {
    repo = new SampleRepo();
    root = mkdtempSync(join(tmpdir(), 'rt-scratch-'));
    const git = new LocalGitHost({ scratchRoot: root });
    const wt = repo.worktree();
    wt.branch('rt/one');
    wt.commit('.gitignore', 'node_modules/\n', 'ignore deps');
    const one = wt.commit('a.txt', 'a\n', 'one');

    const first = await git.mergeInScratch(repo.path, 'main', one as never, 'merge one');
    if (!first.ok) throw new Error('merge failed');
    writeFileSync(join(first.scratchPath, 'node_modules.marker'), 'x'); // untracked, not ignored: cleaned
    writeFileSync(join(first.scratchPath, 'greeting.txt'), 'edited by a test run\n'); // tracked: reset
    // An install the check made: ignored, so it stays for the next run.
    const deps = join(first.scratchPath, 'node_modules');
    mkdirSync(deps);
    writeFileSync(join(deps, 'pkg.js'), 'installed');
    await git.removeScratch(repo.path, first.scratchPath);

    wt.branch('rt/two');
    const two = wt.commit('b.txt', 'b\n', 'two');
    const second = await git.mergeInScratch(repo.path, 'main', two as never, 'merge two');
    if (!second.ok) throw new Error('merge failed');
    expect(second.scratchPath).toBe(first.scratchPath);
    expect(readFileSync(join(second.scratchPath, 'node_modules', 'pkg.js'), 'utf8')).toBe('installed');
    expect(existsSync(join(second.scratchPath, 'node_modules.marker'))).toBe(false);
    expect(readFileSync(join(second.scratchPath, 'greeting.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(second.scratchPath, 'b.txt'))).toBe(true);
  });
});
