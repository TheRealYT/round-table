// S1 "done when" (build-plan.md): a real Claude Code session pairs through the app and exchanges
// messages with a second session. Needs the `claude` CLI with credentials, so it is not part of
// `pnpm e2e`. Run: pnpm --filter @round-table/app build && node e2e/real-claude.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

const ROOT = resolve(import.meta.dirname, '..');
const RT = [process.execPath, join(ROOT, 'packages/cli/src/main.ts')];
const PORT = Number(process.env.RT_E2E_PORT ?? 7790);
const work = mkdtempSync(join(tmpdir(), 'rt-real-'));
const env = { ...process.env, RT_HOME: join(work, 'rt-home') };
const log = (m: string) => console.log(`\n=== ${m}`);

function rt(args: string[]): string {
  const out = spawnSync(RT[0]!, [...RT.slice(1), ...args], { env, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`rt ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout;
}

function claude(dir: string, prompt: string, resume: boolean): string {
  const args = ['-p', prompt, '--allowedTools', 'mcp__roundtable__*', '--output-format', 'text', ...(resume ? ['--continue'] : [])];
  const started = Date.now();
  const out = spawnSync('claude', args, { cwd: dir, env, encoding: 'utf8', timeout: 300_000, input: '' });
  const text = `${out.stdout}${out.stderr}`.trim();
  console.log(`[claude in ${dir.split('/').pop()} ${(Date.now() - started) / 1000}s]\n${text}`);
  return text;
}

async function startHub(): Promise<{ child: ChildProcess; loginUrl: string }> {
  const child = spawn(RT[0]!, [...RT.slice(1), 'hub', 'start', '--port', String(PORT), '--data', join(work, 'hub')], { env });
  let output = '';
  child.stderr?.on('data', (d) => process.stderr.write(d));
  const loginUrl = await new Promise<string>((ok, fail) => {
    child.stdout?.on('data', (d) => {
      output += String(d);
      const m = /(http:\/\/127\.0\.0\.1:\d+\/login\?t=\S+)/.exec(output);
      if (m?.[1]) ok(m[1]);
    });
    child.on('exit', (code) => fail(new Error(`hub exited ${code}: ${output}`)));
  });
  console.log(output.trim());
  return { child, loginUrl };
}

const hub = await startHub();
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  await page.goto(hub.loginUrl);
  await page.getByRole('heading', { name: 'Pairing' }).waitFor();

  const dirs = { a: join(work, 'agent-a'), b: join(work, 'agent-b') };
  for (const [slot, dir] of Object.entries(dirs)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `Scratch workspace for Round Table agent ${slot}.\n`);
    log(`rt agent install --slot ${slot}`);
    console.log(rt(['agent', 'install', '--client', 'claude-code', '--slot', slot, '--dir', dir, '--hub', `ws://127.0.0.1:${PORT}`]));
  }

  async function pair(slot: 'a' | 'b', name: string, project: { newName: string } | { existing: string }) {
    log(`${name}: join`);
    const said = claude(dirs[slot], `Join the Round Table as "${name}" using the roundtable MCP tools, then tell me the match phrase exactly as the tool returned it.`, false);
    const phrase = /\b([a-z]+-[a-z]+-\d{2})\b/.exec(said)?.[1];
    if (!phrase) throw new Error(`${name} did not show a match phrase`);
    const card = page.locator('article.request', { hasText: phrase });
    await card.waitFor();
    if ('newName' in project) {
      await card.getByLabel('Project', { exact: true }).selectOption('new');
      await card.getByLabel('New project name').fill(project.newName);
    } else {
      await card.getByLabel('Project', { exact: true }).selectOption({ label: project.existing });
    }
    await card.getByRole('button', { name: 'Phrase matches, allow' }).click();
    const code = (await page.getByTestId('pairing-code').textContent())?.trim();
    log(`human allowed ${phrase}; pasting code ${code} into ${name}'s chat`);
    claude(dirs[slot], `The human allowed the request. The one-time code is ${code}`, true);
    await page.getByRole('button', { name: 'Done, open project' }).click();
    // Judge pairing by the hub's state, not the model's wording.
    await page.locator('article.agent', { hasText: name }).waitFor({ timeout: 10_000 });
  }

  await pair('a', 'Claude A', { newName: 'Real E2E' });
  await page.locator('.nav-item', { hasText: 'Pairing' }).click();
  await pair('b', 'Claude B', { existing: 'Real E2E' });

  await page.getByRole('heading', { name: 'Real E2E' }).waitFor();
  log('human posts an instruction from the app');
  await page.getByLabel('Instruction').fill('Claude A: send Claude B a one-line greeting that contains the word "pineapple". Claude B: when you get it, reply to Claude A with a one-line answer that contains the word "mango".');
  await page.getByRole('button', { name: 'Send' }).click();

  claude(dirs.a, 'Check the Round Table for messages and do what the human asks. Stop once you have done it.', true);
  claude(dirs.b, 'Check the Round Table for messages and do what the human asks. Stop once you have done it.', true);
  const final = claude(dirs.a, 'Check the Round Table for new messages once and tell me what Claude B said.', true);

  const feed = page.locator('.feed');
  await feed.getByText(/pineapple/i).first().waitFor({ timeout: 10_000 });
  await feed.getByText(/mango/i).first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(ROOT, 'test-results/real-claude-feed.png'), fullPage: true });
  log(`PASS: both agents paired through the app and exchanged messages (A heard: ${/mango/i.test(final) ? 'mango' : 'no mango'})`);
} finally {
  await browser.close();
  hub.child.kill('SIGTERM');
}
