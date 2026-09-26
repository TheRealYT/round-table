// S2 "done when" (build-plan.md): a real leader and real workers deliver a change to the sample repo.
// Three Claude Code sessions, each with its own worktree, work only through the Round Table; this
// script plays the human (setup, plan approval) and restarts agent sessions that end early (D3).
// Needs the `claude` CLI with credentials. Run: node e2e/real-claude-s2.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HubClient } from '@round-table/protocol';
import { WsConnector } from '@round-table/protocol/ws';
import { SampleRepo, git } from '@round-table/testkit';

const ROOT = resolve(import.meta.dirname, '..');
const RT = [process.execPath, join(ROOT, 'packages/cli/src/main.ts')];
const PORT = Number(process.env.RT_E2E_PORT ?? 7792);
const DEADLINE = Date.now() + Number(process.env.RT_E2E_MINUTES ?? 25) * 60_000;
const work = mkdtempSync(join(tmpdir(), 'rt-real-s2-'));
const env = { ...process.env, RT_HOME: join(work, 'rt-home') };
const LOG = join(work, 'agents.log');
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rt(args: string[]): string {
  const out = spawnSync(RT[0]!, [...RT.slice(1), ...args], { env, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`rt ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout;
}

const TOOLS = ['mcp__roundtable__*', 'Bash(git:*)', 'Bash(sh test.sh)', 'Bash(cat:*)', 'Bash(ls:*)', 'Read', 'Edit', 'Write'].join(',');

function claudeSync(dir: string, prompt: string, resume: boolean): string {
  const out = spawnSync('claude', ['-p', prompt, '--allowedTools', TOOLS, '--output-format', 'text', ...(resume ? ['--continue'] : [])], { cwd: dir, env, encoding: 'utf8', timeout: 300_000, input: '' });
  return `${out.stdout}${out.stderr}`.trim();
}

/** A long-running agent session; resolves when the model ends its turn. */
function claudeRun(name: string, dir: string, prompt: string): Promise<string> {
  return new Promise((resolveRun) => {
    const child: ChildProcess = spawn('claude', ['-p', prompt, '--allowedTools', TOOLS, '--output-format', 'text', '--continue'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    const killer = setTimeout(() => child.kill('SIGTERM'), Math.max(0, DEADLINE - Date.now()));
    child.on('close', () => {
      clearTimeout(killer);
      appendFileSync(LOG, `\n===== ${name} (${new Date().toISOString()})\n${out}\n`);
      resolveRun(out.trim());
    });
  });
}

// ── hub, repo, agents ───────────────────────────────────────────────────────────────────────
const repo = new SampleRepo();
const hubProcess = spawn(RT[0]!, [...RT.slice(1), 'hub', 'start', '--port', String(PORT), '--data', join(work, 'hub')], { env });
const loginUrl = await new Promise<string>((ok, fail) => {
  let output = '';
  hubProcess.stdout?.on('data', (d) => {
    output += String(d);
    const m = /(http:\/\/127\.0\.0\.1:\d+\/login\?t=\S+)/.exec(output);
    if (m?.[1]) ok(m[1]);
  });
  hubProcess.on('exit', (code) => fail(new Error(`hub exited ${code}: ${output}`)));
});
// The human's session: the same cookie the app would get from the login link.
const login = await fetch(loginUrl, { redirect: 'manual' });
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const human = new HubClient(await new WsConnector(`ws://127.0.0.1:${PORT}`, { headers: { cookie } }).connect('app'));
log(`hub up; work dir ${work}; sample repo ${repo.path}`);

const agents = { lead: 'Lead', ada: 'Ada', bo: 'Bo' } as const;
type Slot = keyof typeof agents;
const dirs = Object.fromEntries(Object.keys(agents).map((s) => [s, join(work, s)])) as Record<Slot, string>;
for (const slot of Object.keys(agents) as Slot[]) {
  rt(['agent', 'install', '--client', 'claude-code', '--slot', slot, '--dir', dirs[slot], '--repo', repo.path, '--hub', `ws://127.0.0.1:${PORT}`]);
}

let projectId = '';
const ids: Partial<Record<Slot, string>> = {};
for (const slot of Object.keys(agents) as Slot[]) {
  const said = claudeSync(dirs[slot], `Join the Round Table as "${agents[slot]}" using the roundtable MCP tools, then tell me the match phrase exactly as the tool returned it.`, false);
  const phrase = /\b([a-z]+-[a-z]+-\d{2})\b/.exec(said)?.[1];
  const { requests } = await human.call<{ requests: Array<{ requestId: string; matchPhrase: string }> }>('pairing.list');
  const request = requests.find((r) => r.matchPhrase === phrase);
  if (!request) throw new Error(`${agents[slot]} did not show a matching phrase: ${said}`);
  const allowed = await human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: request.requestId, ...(projectId ? { projectId } : { newProjectName: 'Greeting (real agents)' }) });
  projectId = allowed.projectId;
  claudeSync(dirs[slot], `The human allowed the request. The one-time code is ${allowed.code}`, true);
  const { agents: paired } = await human.call<{ agents: Array<{ agentId: string; name: string }> }>('pairing.list');
  ids[slot] = paired.find((a) => a.name === agents[slot])?.agentId;
  if (!ids[slot]) throw new Error(`${agents[slot]} did not finish pairing`);
  log(`${agents[slot]} paired as ${ids[slot]}`);
}

// ── the human sets up the project ──────────────────────────────────────────────────────────
await human.call('leader.assign', { projectId, agentId: ids.lead });
await human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
await human.call('rules.edit', { projectId, rules: { testCommand: 'sh test.sh', testTimeoutSec: 60, conventions: ['one branch per task, named as claim suggests'] } });
await human.call('goal.set', { projectId, goal: { objective: 'Change greeting.txt so the greeting reads exactly "hello there".', successCriteria: ['greeting.txt contains exactly the line: hello there', 'sh test.sh passes'] } });
log('human: leader assigned, repo attached, test command and goal set');

const PROMPTS: Record<Slot, string> = {
  lead: `You are the Round Table leader for this project. You coordinate only: never write code, review or test. Work the protocol: call wait repeatedly; when a worker proposes a task that serves the goal, inspect it (board_get) and board_commit it, or board_reject with a reason; answer questions briefly with send. Keep going until you receive a message that the task is done, then stop.`,
  ada: `You are a worker on the Round Table (Ada). Steps: 1) board_view "me" to read the goal. 2) Propose one task that achieves it: board_propose section "tasks", op "add", data {title, criteria: [...]}. 3) Call wait until the plan is approved and the task is ready (board_read "tasks"), then claim it. 4) In this directory (your git worktree) create the branch claim gives you (git switch -c <branch>), make the change, run sh test.sh, and commit. 5) Open a change request (board_propose section "artifacts", op "open", data {kind: "change_request", taskId, branch}). 6) Ask Bo (find Bo's agentId with board_read "roster") for a review AND a test of your change request with request. 7) Keep calling wait and handle feedback until a message says the task is done, then stop.`,
  bo: `You are a worker on the Round Table (Bo), acting as reviewer and tester. Call wait repeatedly. When asked to review or test a change request: in this directory (your git worktree) run git checkout --detach <headSha from the request>, read the task's criteria (board_get the task), check the change, run sh test.sh, then respond to that request with your verdict for that exact headSha. Keep going until a message says the task is done, then stop.`,
};

// ── run the agents; approve the plan when it appears; restart sessions that end early ──────
type Overview = { taskCounts: Record<string, number>; tasks: Array<{ taskId: string; title: string; status: string }> };
let done = false;
let approved = false;
const restarts: Record<Slot, number> = { lead: 0, ada: 0, bo: 0 };

async function supervise(slot: Slot): Promise<void> {
  let prompt = PROMPTS[slot];
  while (!done && Date.now() < DEADLINE && restarts[slot] < 8) {
    const out = await claudeRun(agents[slot], dirs[slot], prompt);
    log(`${agents[slot]} session ended: ${out.split('\n').slice(-2).join(' ').slice(0, 200)}`);
    if (done) break;
    restarts[slot] += 1;
    prompt = 'Continue your Round Table work per the protocol: call wait and act on what arrives. Stop only when a message says the task is done.';
  }
}

async function humanLoop(): Promise<void> {
  while (!done && Date.now() < DEADLINE) {
    const view = await human.call<Overview>('board_view', { view: 'overview', projectId });
    if (!approved && (view.taskCounts.proposed ?? 0) > 0) {
      await human.call('plan.approve', { projectId });
      approved = true;
      log(`human: approved the plan (${view.tasks.map((t) => t.title).join('; ')})`);
    }
    if ((view.taskCounts.done ?? 0) > 0) {
      done = true;
      log('task done');
    }
    await sleep(3_000);
  }
}

await Promise.all([humanLoop(), supervise('lead'), supervise('ada'), supervise('bo')]);

// ── check the outcome ─────────────────────────────────────────────────────────────────────
const { records: changes } = await human.call<{ records: Array<{ status: string; author: string; reviews: Array<{ by: string; verdict: string }>; testResults: Array<{ by: string; status: string }>; hubRuns: Array<{ status: string }>; mergeSha: string | null }> }>('board_read', { projectId, section: 'artifacts' });
const greeting = repo.fileOnMain('greeting.txt');
const testsOnMain = spawnSync('sh', ['-c', `git -C ${repo.path} show main:test.sh | (cd $(mktemp -d) && git -C ${repo.path} archive main | tar -x && sh test.sh)`], { encoding: 'utf8' });
log(`main greeting.txt: ${JSON.stringify(greeting)}; tests on main: ${testsOnMain.status === 0 ? 'pass' : 'fail'}`);
log(`change requests: ${JSON.stringify(changes)}`);
log(`restarts: ${JSON.stringify(restarts)}; agent transcripts: ${LOG}`);
const merged = changes.find((c) => c.status === 'merged');
const ok = done && merged && merged.author === ids.ada && merged.reviews.some((r) => r.by === ids.bo && r.verdict === 'approved') && merged.hubRuns.some((r) => r.status === 'pass') && /hello there/.test(greeting) && testsOnMain.status === 0;
log(ok ? 'PASS: real agents delivered the change through the Round Table' : 'FAIL');
console.log(git(repo.path, 'log', '--oneline', '--graph', 'main'));
human.close();
hubProcess.kill('SIGTERM');
process.exit(ok ? 0 : 1);
