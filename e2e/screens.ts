// Screenshots of the app in a realistic state, for design review: node e2e/screens.ts [outDir]
// A real hub with a fake driver plays three hub-run agents mid-task, plus one chat-joined agent.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { authenticate, confirmJoin, requestJoin } from '@round-table/agent';
import { FakeAgentHost, FakeDriver, SampleRepo } from '@round-table/testkit';
import { startHub } from './hub-fixture.ts';

const CHROMIUM = process.env.RT_CHROMIUM ?? '/opt/pw-browsers/chromium';
const out = process.argv[2] ?? 'test-results/screens';
mkdirSync(out, { recursive: true });
const driver = new FakeDriver();
const h = await startHub({ agents: new FakeAgentHost(), drivers: { 'claude-code': driver } });
const human = await h.human();
const repo = new SampleRepo();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { projectId } = await human.call<{ projectId: string }>('project.create', { name: 'Checkout redesign' });
await human.call('project.create', { name: 'Docs site' });
await human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
await human.call('rules.edit', { projectId, rules: { testCommand: 'npm test' } });
await human.call('goal.set', { projectId, goal: { objective: 'Move the cart to a single page with inline address validation.' } });
const { providerId } = await human.call<{ providerId: string }>('provider.save', { settings: { kind: 'claude-code', label: 'Claude Code', command: '', auth: 'cli-login', model: 'sonnet', extraArgs: [], maxInstances: 4 } });
await human.call('provider.save', { settings: { kind: 'codex', label: 'Codex', command: '', auth: 'api-key', model: '', extraArgs: [], maxInstances: 2 } });
const { started } = await human.call<{ started: Array<{ name: string; agentId: string }> }>('agent.spawn', { projectId, providerId, names: ['Lead', 'Ada', 'Bo'] });
const id = Object.fromEntries(started.map((s) => [s.name, s.agentId]));
await human.call('leader.assign', { projectId, agentId: id.Lead });
await sleep(100);

// A chat-joined agent too.
const chat = await h.agent();
const pending = await requestJoin(chat, { name: 'Cursor Cy', client: 'cursor' });
const { code } = await human.call<{ code: string }>('pairing.allow', { requestId: pending.request.requestId, projectId });
await authenticate(chat, await confirmJoin(chat, pending, code, Date.now()));
await requestJoin(await h.agent(), { name: 'Gemini Dee', client: 'antigravity' }); // waiting in Pairing

const proc = (name: string) => driver.of(id[name]!)!;
for (const name of ['Lead', 'Ada', 'Bo']) proc(name).emit({ type: 'session', sessionId: `s-${name}` });
proc('Ada').emit({ type: 'text', text: 'Reading the cart components to size the work.' });
proc('Ada').emit({ type: 'tool', name: 'Bash', input: '{"command":"ls src/cart && git log --oneline -5"}' });
proc('Ada').emit({ type: 'tool', name: 'mcp__roundtable__board_propose', input: '{"section":"tasks","op":"add","data":{"title":"Single-page cart"}}' });
proc('Ada').endTurn({ sessionCostUsd: 0.31 });
proc('Bo').endTurn({ sessionCostUsd: 0.12 });
proc('Lead').endTurn({ sessionCostUsd: 0.08 });
await sleep(100);
const t = await human.call<{ records: Array<{ id: string }> }>('board_read', { section: 'tasks', projectId });
void t;
await human.call('human.post', { projectId, to: 'all', body: 'Keep the old cart behind a flag until QA signs off.' });
await sleep(200);
proc('Ada').emit({ type: 'tool', name: 'mcp__roundtable__claim', input: '{"taskId":"tsk_…"}' });
proc('Bo').emit({ type: 'exit', code: 1, error: 'API Error: 529 overloaded' });
await sleep(50);

const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const shots: Array<[string, string]> = [['agents', '#/agents'], ['project', `#/project/${encodeURIComponent(projectId)}`], ['pairing', '#/pairing']];
for (const scheme of ['dark', 'light'] as const) {
  for (const [w, hgt, label] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']] as const) {
    const context = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(h.loginUrl());
    for (const [name, hash] of shots) {
      await page.evaluate((x) => (location.hash = x), hash);
      await sleep(900);
      await page.screenshot({ path: `${out}/${name}-${label}-${scheme}.png`, fullPage: true });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
        ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('.table-wrap, .kanban')).slice(0, 5).map((e) => `${e.tagName}.${e.className}`)
        : []);
      if (wide.length) console.log(`${name}/${label}/${scheme} wider than the viewport: ${wide.join(', ')}`);
      // Optional design audit (frontend-craft's audit.js): RT_AUDIT_JS=/path/to/audit.js
      if (process.env.RT_AUDIT_JS) {
        const result = (await page.evaluate(readFileSync(process.env.RT_AUDIT_JS, 'utf8'))) as { issues: Array<{ level: string; rule: string; msg: string; sel: string }> };
        for (const i of result.issues.filter((x) => x.level !== 'info')) console.log(`${name}/${label}/${scheme} ${i.level} ${i.rule}: ${i.msg} ${i.sel}`);
      }
    }
    await context.close();
  }
}
await browser.close();
human.close();
await h.close();
repo.dispose();
console.log(`screens in ${out}`);
