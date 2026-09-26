import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clientProfile, createAgentWorktree, installAgent, rtHome } from '@round-table/agent';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

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
    `Agent folders (git worktrees): ${slots.map((s) => join(dir, s)).join(', ')}.`,
    '',
    '## Steps',
    '',
    '1. Start the hub (keep it running): `node ' + MAIN + ' hub start`, and open the login link it prints. Lost it? `node ' + MAIN + ' hub login`.',
    `2. Set the project up first, so agents have work the moment they join. In the app, add a project (sidebar). Under Setup, set the goal (e.g. "Change greeting.txt so it reads exactly: hello there"), attach the repository ${repo}, and set the test command \`sh test.sh\`.`,
    `3. In one terminal per agent, start ${profile.name} in its folder and say "Join the Round Table as ${title(lead)}" (${title(author)}, ${title(reviewer)} in the others).`,
    `   ${profile.id === 'codex' ? 'Codex: trust the folder when asked. ' : profile.id === 'gemini' ? 'Gemini CLI: trust the folder when asked. ' : ''}Approve the roundtable tools if the client asks.`,
    '4. Each agent shows a match phrase. In the app under Pairing, check it, allow it into your project, and paste the code into that agent\'s chat.',
    `5. Click "Make leader" on ${title(lead)}. That's all the chat is for: from here the Round Table drives each agent. Every tool result ends with "[Round Table] next", and the agents keep working through their tools without prompts.`,
    '6. When a proposed task appears under Tasks, click "Approve plan". Watch the board and the feed: claim, change request, review and test by another agent, the hub\'s own test run, and the merge.',
    '7. When it\'s done, post "The goal is done, please stop" from the composer; the agents stop.',
    `8. Check the result: \`git -C ${repo} log --oneline --graph main\`.`,
    '',
    '## If an agent stops',
    '',
    'An MCP server can\'t wake a model whose turn has ended. If an agent card in the app says "Idle", type "continue" in that agent\'s chat. Some IDEs also pause after a number of tool calls in one turn; "continue" resumes it the same way.',
    '',
    'Try things too: post an instruction from the composer while they work, restart an agent (it rejoins by itself), or ask the author to make the test fail and watch the hub refuse the merge.',
    '',
    `Identities for this demo live in ${rtHome()}/identities. To start over: stop the hub, delete ${dir} and ${rtHome()}.`,
  ];
  writeFileSync(join(dir, 'README.md'), `${steps.join('\n')}\n`);
  console.log(steps.join('\n'));
  console.log(`\n(These steps are saved in ${join(dir, 'README.md')}.)`);
}
