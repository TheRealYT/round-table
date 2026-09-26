import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Files `rt agent install` writes into a worktree; kept out of commits via the repo's info/exclude. */
const CLIENT_FILES = ['.mcp.json', '.claude/settings.local.json', '.codex/', '.gemini/', 'opencode.json', '.cursor/', '.vscode/mcp.json'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * One worktree per agent (spec: Code sharing), detached at main: the agent creates one branch per
 * task in it. The hub merges into main itself, so no agent ever needs main checked out.
 */
export function createAgentWorktree(repo: string, dir: string, mainBranch = 'main'): { dir: string; created: boolean } {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    // Reuse an existing worktree of the same repository; refuse anything else.
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common !== git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) {
      throw new Error(`${dir} exists and is not a worktree of ${repo}`);
    }
    // The first entry of `worktree list` is the primary checkout: never hand that to an agent.
    const primary = git(repo, ['worktree', 'list', '--porcelain']).split('\n')[0]?.replace(/^worktree /, '');
    if (primary === git(dir, ['rev-parse', '--show-toplevel'])) throw new Error(`${dir} is the repository's main checkout; give the agent its own directory`);
    excludeClientFiles(repo);
    return { dir, created: false };
  }
  git(repo, ['worktree', 'add', '--detach', dir, mainBranch]);
  excludeClientFiles(repo);
  return { dir, created: true };
}

function excludeClientFiles(repo: string): void {
  const exclude = join(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const missing = CLIENT_FILES.filter((f) => !current.split('\n').includes(f));
  if (missing.length > 0) appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}# Round Table agent config\n${missing.join('\n')}\n`);
}
