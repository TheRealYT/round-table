import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * A throwaway repository shaped like the MVP sample: `main` with a greeting file and a test script
 * the hub runs (`sh test.sh`). The primary checkout is detached so the hub can move `main` freely.
 */
export class SampleRepo {
  readonly root: string;
  readonly path: string;
  private worktrees = 0;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'rt-repo-'));
    this.path = join(this.root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', this.path]);
    writeFileSync(join(this.path, 'greeting.txt'), 'hello\n');
    // The acceptance test: the greeting must say hello, and must not say "broken".
    writeFileSync(join(this.path, 'test.sh'), 'grep -q hello greeting.txt && ! grep -q broken greeting.txt && echo "tests pass"\n');
    git(this.path, 'add', '.');
    git(this.path, 'commit', '-q', '-m', 'initial');
    git(this.path, 'switch', '-q', '--detach');
  }

  main(): string {
    return git(this.path, 'rev-parse', 'refs/heads/main');
  }

  fileOnMain(file: string): string {
    return git(this.path, 'show', `main:${file}`);
  }

  /** A worktree for one agent, like `rt agent install --repo`. */
  worktree(): Worktree {
    const dir = join(this.root, `wt-${++this.worktrees}`);
    git(this.path, 'worktree', 'add', '-q', '--detach', dir, 'main');
    return new Worktree(dir);
  }

  /** Someone else lands a commit on main (for conflict tests). */
  commitOnMain(file: string, content: string, message: string): string {
    const wt = this.worktree();
    wt.branch(`side-${Date.now()}`);
    const sha = wt.commit(file, content, message);
    git(this.path, 'update-ref', 'refs/heads/main', sha);
    return sha;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export class Worktree {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  branch(name: string): void {
    git(this.dir, 'switch', '-q', '-c', name);
  }
  commit(file: string, content: string, message: string): string {
    writeFileSync(join(this.dir, file), content);
    git(this.dir, 'add', file);
    git(this.dir, 'commit', '-q', '-m', message);
    return git(this.dir, 'rev-parse', 'HEAD');
  }
  read(file: string): string {
    return readFileSync(join(this.dir, file), 'utf8');
  }
}
