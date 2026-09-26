import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientProfile, createAgentWorktree, installAgent, rtHome } from '@round-table/agent';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** Role prompts that work well with the S2 feature set (the same ones e2e/real-claude-s2.ts uses). */
export const ROLE_PROMPTS = {
  leader: `You are the Round Table leader for this project. You coordinate only: never write code, review or test. Work the protocol: call wait repeatedly; when a worker proposes a task that serves the goal, inspect it (board_get) and board_commit it, or board_reject with a reason; answer questions briefly with send. Keep going until you receive a message that the task is done, then stop.`,
  author: (reviewer: string) =>
    `You are a worker on the Round Table. Steps: 1) board_view "me" to read the goal. 2) Propose one task that achieves it: board_propose section "tasks", op "add", data {title, criteria: [...]}. 3) Call wait until the plan is approved and the task is ready (board_read "tasks"), then claim it. 4) In this directory (your git worktree) create the branch claim gives you (git switch -c <branch>), make the change, run sh test.sh, and commit. 5) Open a change request (board_propose section "artifacts", op "open", data {kind: "change_request", taskId, branch}). 6) Ask ${reviewer} (find the agentId with board_read "roster") for a review AND a test of your change request with request. 7) Keep calling wait and handle feedback until a message says the task is done, then stop.`,
  reviewer: `You are a worker on the Round Table, acting as reviewer and tester. Call wait repeatedly. When asked to review or test a change request: in this directory (your git worktree) run git checkout --detach <headSha from the request>, read the task's criteria (board_get the task), check the change, run sh test.sh, then respond to that request with your verdict for that exact headSha. Keep going until a message says the task is done, then stop.`,
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Round Table demo', '-c', 'user.email=demo@round-table.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
}

/**
 * `rt demo`: a sample repository (greeting.txt + test.sh), one worktree per agent installed for a
 * client, and a README with the steps and role prompts. Nothing starts; the human drives it.
 */
export function demo(args: string[]): void {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, client: { type: 'string' }, agents: { type: 'string' }, hub: { type: 'string' } } });
  const dir = resolve(values.dir ?? join(homedir(), 'rt-demo'));
  const profile = clientProfile(values.client ?? 'claude-code');
  const [lead = 'lead', author = 'ada', reviewer = 'bo', ...more] = (values.agents ?? 'lead,ada,bo').split(',').map((a) => a.trim()).filter(Boolean);
  if (existsSync(join(dir, 'repo'))) throw new Error(`${dir}/repo already exists; pick another --dir or remove it`);
  mkdirSync(dir, { recursive: true });

  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  writeFileSync(join(repo, 'test.sh'), 'grep -q hello greeting.txt && ! grep -q broken greeting.txt && echo "tests pass"\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  // The hub moves main when it merges; keep main unchecked-out so no checkout goes stale.
  git(repo, 'switch', '-q', '--detach');

  const hubUrl = values.hub ?? 'ws://127.0.0.1:7777';
  const env = process.env.RT_HOME ? { RT_HOME: process.env.RT_HOME } : undefined;
  const slots = [lead, author, reviewer, ...more];
  for (const slot of slots) {
    createAgentWorktree(repo, join(dir, slot));
    installAgent({ client: profile.id, dir: join(dir, slot), slot, hubUrl, command: [process.execPath, MAIN], ...(env && { env }) });
  }

  const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const steps = [
    `# Round Table demo (${profile.name})`,
    '',
    `Sample repository: ${repo} (greeting.txt says "hello"; the test is \`sh test.sh\`).`,
    `Agent worktrees: ${slots.map((s) => join(dir, s)).join(', ')}.`,
    '',
    '## Steps',
    '',
    '1. Start the hub (keep it running): `node ' + MAIN + ' hub start` and open the login link it prints. Lost it? `node ' + MAIN + ' hub login`.',
    `2. In one terminal per agent, start ${profile.name} in its folder and say "Join the Round Table as ${title(lead)}" (${title(author)}, ${title(reviewer)} in the others).`,
    `   ${profile.id === 'codex' ? 'Codex: trust the folder when asked. ' : profile.id === 'gemini' ? 'Gemini CLI: trust the folder when asked. ' : ''}Approve the roundtable tools when the client asks.`,
    '3. Each agent shows a match phrase. In the app, Pairing: check the phrase, allow it (first one into a new project, the rest into the same project), and paste the code into that agent\'s chat.',
    `4. In the app, open the project: click "Make leader" on ${title(lead)}. Under Setup: set a goal, e.g. "Change greeting.txt so it reads exactly: hello there", attach the repository path ${repo}, and set the test command \`sh test.sh\`.`,
    '5. Give each agent its role prompt (below).',
    '6. When a proposed task appears under Tasks, click "Approve plan". Then watch the board and the feed: claim, change request, review and test, the hub\'s own test run, and the merge.',
    `7. Check the result: \`git -C ${repo} log --oneline --graph main\` and \`git -C ${repo} show main:greeting.txt\`.`,
    '',
    '## Role prompts',
    '',
    `### ${title(lead)} (leader)`,
    '',
    ROLE_PROMPTS.leader,
    '',
    `### ${title(author)} (worker, author)`,
    '',
    ROLE_PROMPTS.author(title(reviewer)),
    '',
    `### ${title(reviewer)} (worker, reviewer and tester)`,
    '',
    ROLE_PROMPTS.reviewer,
    '',
    'Try things too: post an instruction from the app\'s composer while they work, kill an agent\'s session and restart it (it rejoins by itself), or make the change fail the test and see the hub refuse the merge.',
    '',
    `Identities for this demo live in ${rtHome()}/identities. To start over: stop the hub, delete ${dir} and ${rtHome()}.`,
  ];
  writeFileSync(join(dir, 'README.md'), `${steps.join('\n')}\n`);
  console.log(steps.join('\n'));
  console.log(`\n(These steps are saved in ${join(dir, 'README.md')}.)`);
}
