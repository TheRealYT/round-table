// S2b manual check (ADR-0018): the hub runs three real agents from one provider, with no chat open
// anywhere, and they deliver a change to a sample repo. The script only plays the human: sets up
// the project, starts the agents, approves the plan.
//   node e2e/real-driven.ts                              # Claude Code
//   RT_E2E_KIND=antigravity node e2e/real-driven.ts      # Antigravity CLI (agy)
import { SampleRepo } from '@round-table/testkit';
import { startHub } from './hub-fixture.ts';

const MINUTES = Number(process.env.RT_E2E_MINUTES ?? 20);
const deadline = Date.now() + MINUTES * 60_000;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const h = await startHub({ agents: 'real' });
const human = await h.human();
const repo = new SampleRepo();
log(`hub ${h.base}; data ${h.dir}; repo ${repo.path}`);
log(`app: ${h.loginUrl()}`);

const { projectId } = await human.call<{ projectId: string }>('project.create', { name: 'Greeting (hub-run agents)' });
await human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
await human.call('rules.edit', { projectId, rules: { testCommand: 'sh test.sh', testTimeoutSec: 60 } });
await human.call('goal.set', { projectId, goal: { objective: 'Change greeting.txt so the greeting reads exactly "hello there".', successCriteria: ['greeting.txt contains exactly the line: hello there', 'sh test.sh passes'] } });
const KIND = process.env.RT_E2E_KIND ?? 'claude-code';
const { providerId } = await human.call<{ providerId: string }>('provider.save', { settings: { kind: KIND, label: KIND, command: process.env.RT_E2E_BIN ?? '', auth: 'cli-login', model: process.env.RT_E2E_MODEL ?? '', extraArgs: [], maxInstances: 3 } });
log(`provider: ${KIND}`);
const spawned = await human.call<{ started: Array<{ name: string; agentId: string }>; failed: unknown[] }>('agent.spawn', { projectId, providerId, names: ['Lead', 'Ada', 'Bo'] });
if (spawned.failed.length) throw new Error(`spawn failed: ${JSON.stringify(spawned.failed)}`);
const id = Object.fromEntries(spawned.started.map((s) => [s.name, s.agentId]));
await human.call('leader.assign', { projectId, agentId: id.Lead });
log(`started ${spawned.started.map((s) => s.name).join(', ')}; Lead is leader`);

type Overview = { tasks: Array<{ taskId: string; title: string; status: string }> };
type Row = { name: string; connected: boolean; driven: { turns: number; costUsd: number; live: { status: string; lastError: string | null; tool: string | null } } | null };
let approved = false;
let lastLine = '';
let outcome = 'timeout';
while (Date.now() < deadline) {
  await sleep(5_000);
  const board = await human.call<Overview>('board_view', { projectId, view: 'overview' });
  const { records } = await human.call<{ records: Row[] }>('board_read', { section: 'roster', projectId });
  const line = `${records.map((r) => `${r.name}:${r.driven?.live.status}${r.driven?.live.tool ? `(${r.driven.live.tool})` : ''}${r.connected ? '' : ' offline'} t${r.driven?.turns} $${r.driven?.costUsd.toFixed(2)}`).join('  ')} | tasks: ${board.tasks.map((t) => `${t.title.slice(0, 30)}=${t.status}`).join(', ') || 'none'}`;
  if (line !== lastLine) log(line);
  lastLine = line;
  const crashed = records.find((r) => r.driven?.live.status === 'crashed');
  if (crashed) log(`${crashed.name} crashed: ${crashed.driven?.live.lastError}`);
  if (!approved && board.tasks.some((t) => t.status === 'proposed')) {
    await sleep(3_000);
    await human.call('plan.approve', { projectId });
    approved = true;
    log('human: plan approved');
  }
  if (board.tasks.length > 0 && board.tasks.every((t) => t.status === 'done')) {
    outcome = 'done';
    break;
  }
}
for (const name of ['Lead', 'Ada', 'Bo']) {
  const { entries } = await human.call<{ entries: Array<{ kind: string; text: string }> }>('agent.transcript', { projectId, agentId: id[name] });
  log(`── ${name} transcript (last 12) ──\n${entries.slice(-12).map((e) => `  ${e.kind}: ${e.text.slice(0, 220).replace(/\n/g, ' ⏎ ')}`).join('\n')}`);
}
log(`outcome: ${outcome}; main now: ${JSON.stringify(repo.fileOnMain('greeting.txt'))}`);
human.close();
await h.close();
process.exit(outcome === 'done' ? 0 : 1);
