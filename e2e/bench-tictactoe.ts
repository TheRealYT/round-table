// S2c benchmark: how long a small real project takes, and where the time goes. The hub runs a
// leader and two workers (Claude Code by default) that build a tic-tac-toe game in an empty repo;
// the script plays the human and approves the plan at once, so the numbers are the team's own.
//   node e2e/bench-tictactoe.ts [out-dir]                 # writes report.txt, insights.json, hub.db
//   RT_E2E_KIND=antigravity node e2e/bench-tictactoe.ts
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { projectInsights } from '@round-table/hub';
import { renderReport } from '../packages/cli/src/report.ts';
import { startHub } from './hub-fixture.ts';

const MINUTES = Number(process.env.RT_E2E_MINUTES ?? 60);
const out = resolve(process.argv[2] ?? `bench-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const deadline = Date.now() + MINUTES * 60_000;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An empty project: a package.json whose tests use node's own runner, so checks need no install.
const repo = join(mkdtempSync(join(tmpdir(), 'rt-bench-')), 'tictactoe');
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'bench@example.com');
git('config', 'user.name', 'bench');
writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'tictactoe', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
writeFileSync(join(repo, 'README.md'), '# Tic-tac-toe\n');
git('add', '.');
git('commit', '-q', '-m', 'empty project');

const h = await startHub({ agents: 'real' });
const human = await h.human();
log(`hub ${h.base}; data ${h.dir}; repo ${repo}`);
log(`app: ${h.loginUrl()}`);

const { projectId } = await human.call<{ projectId: string }>('project.create', { name: 'Tic-tac-toe (benchmark)' });
await human.call('repo.attach', { projectId, path: repo, mainBranch: 'main' });
await human.call('rules.edit', { projectId, rules: { testCommand: 'npm test', testTimeoutSec: 120 } });
await human.call('goal.set', {
  projectId,
  goal: {
    objective: 'Build a small tic-tac-toe game that runs in the browser: open index.html, two players take turns, the game shows the winner or a draw, and a button restarts it.',
    successCriteria: ['index.html plays a full game in a browser with no build step', 'game logic lives in a module with node --test tests for wins, draws and illegal moves', 'npm test passes'],
  },
});
const KIND = process.env.RT_E2E_KIND ?? 'claude-code';
const { providerId } = await human.call<{ providerId: string }>('provider.save', { settings: { kind: KIND, label: KIND, command: process.env.RT_E2E_BIN ?? '', auth: 'cli-login', model: process.env.RT_E2E_MODEL ?? '', extraArgs: [], maxInstances: 3 } });
const spawned = await human.call<{ started: Array<{ name: string; agentId: string }>; failed: unknown[] }>('agent.spawn', { projectId, providerId, names: ['Lead', 'Ada', 'Bo'] });
if (spawned.failed.length) throw new Error(`spawn failed: ${JSON.stringify(spawned.failed)}`);
const lead = spawned.started.find((s) => s.name === 'Lead')!;
await human.call('leader.assign', { projectId, agentId: lead.agentId });
const started = Date.now();
log(`provider ${KIND}; started ${spawned.started.map((s) => s.name).join(', ')}; Lead is leader`);

type Overview = { tasks: Array<{ title: string; status: string }> };
let lastLine = '';
let outcome = 'timeout';
let quietSince = Date.now();
while (Date.now() < deadline) {
  await sleep(5_000);
  const board = await human.call<Overview>('board_view', { projectId, view: 'overview' });
  const line = board.tasks.map((t) => `${t.title.slice(0, 28)}=${t.status}`).join(', ') || 'no tasks yet';
  if (line !== lastLine) {
    log(line);
    lastLine = line;
    quietSince = Date.now();
  }
  if (board.tasks.some((t) => t.status === 'proposed')) {
    await human.call('plan.approve', { projectId });
    log('human: plan approved');
  }
  const open = board.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  // Done once every task is done and nothing new was proposed for a minute.
  if (board.tasks.length > 0 && open.length === 0 && Date.now() - quietSince > 60_000) {
    outcome = 'done';
    break;
  }
}
const minutes = ((Date.now() - started) / 60_000).toFixed(1);
const insights = projectInsights(h.hub.store.reader, projectId);
const text = `${renderReport('Tic-tac-toe benchmark', insights)}\n\nOutcome: ${outcome} after ${minutes} min (provider ${KIND}).\nFiles on main: ${execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').join(', ')}`;
console.log(`\n${text}`);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.txt'), `${text}\n`);
writeFileSync(join(out, 'insights.json'), `${JSON.stringify({ outcome, minutes: Number(minutes), kind: KIND, ...insights }, null, 2)}\n`);
copyFileSync(join(h.dir, 'hub.db'), join(out, 'hub.db'));
log(`wrote ${out}`);
human.close();
await h.close();
process.exit(outcome === 'done' ? 0 : 1);
