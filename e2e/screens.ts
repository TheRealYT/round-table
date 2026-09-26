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
const ada = proc('Ada');
ada.emit({ type: 'thinking', text: 'The goal is a single-page cart. Before proposing tasks I should see how the cart is split today and what the tests cover.\nIf address validation is its own module, it can be a separate task.' });
ada.emit({ type: 'tool', id: 'a1', name: 'mcp__roundtable__board_view', input: '{"view":"me"}' });
ada.emit({ type: 'tool_result', id: 'a1', output: '{"role":"worker","goal":"Move the cart to a single page with inline address validation.","tasks":[]}', isError: false });
ada.emit({ type: 'tool', id: 'a2', name: 'Bash', input: '{"command":"ls src/cart && git log --oneline -5"}' });
ada.emit({ type: 'tool_result', id: 'a2', output: 'CartPage.tsx\nCartSummary.tsx\nShippingStep.tsx\naddress.ts\n\n9f2c1ab Split shipping into its own step\n41d0e77 Cart summary totals\n', isError: false });
ada.emit({ type: 'tool', id: 'a3', name: 'Read', input: '{"file_path":"/repo/src/cart/address.ts"}' });
ada.emit({ type: 'tool_result', id: 'a3', output: 'export function validateAddress(a: Address): string[] {\n  const errors: string[] = [];\n  if (!a.postcode) errors.push("postcode");\n  return errors;\n}\n', isError: false });
ada.emit({ type: 'tool', id: 'a4', name: 'Bash', input: '{"command":"npm test -- cart"}' });
ada.emit({ type: 'tool_result', id: 'a4', output: 'FAIL src/cart/address.test.ts\n  ✕ rejects a missing street (4 ms)\n\nTests: 1 failed, 11 passed', isError: true });
ada.emit({ type: 'text', text: 'The cart is split into three steps, and `validateAddress` only checks the postcode, which is why one test already fails. I\'ll propose:\n\n1. **Single-page cart layout**: merge `CartPage` and `ShippingStep`.\n2. **Inline address validation**: extend `validateAddress` and show errors as you type.' });
ada.emit({ type: 'tool', id: 'a5', name: 'mcp__roundtable__board_propose', input: '{"section":"tasks","op":"add","data":{"title":"Single-page cart layout"}}' });
ada.emit({ type: 'tool_result', id: 'a5', output: '{"ticketId":"tkt_01…","status":"open"}', isError: false });
ada.endTurn({ sessionCostUsd: 0.31 });
ada.send('[Round Table] message from Cursor Cy (chat): I took the layout; can you take address validation?\n\n[Round Table] next: Claim task "Inline address validation".');
ada.emit({ type: 'thinking', text: 'Cy has the layout. I will claim validation.' });
ada.emit({ type: 'tool', id: 'b1', name: 'Edit', input: '{"file_path":"/repo/src/cart/address.ts","old_string":"  if (!a.postcode) errors.push(\\"postcode\\");","new_string":"  if (!a.postcode) errors.push(\\"postcode\\");\\n  if (!a.street?.trim()) errors.push(\\"street\\");"}' });
ada.emit({ type: 'tool_result', id: 'b1', output: 'The file /repo/src/cart/address.ts has been updated.', isError: false });
ada.emit({ type: 'tool', id: 'b2', name: 'Bash', input: '{"command":"npm test -- cart"}' });
proc('Bo').endTurn({ sessionCostUsd: 0.12 });
proc('Lead').endTurn({ sessionCostUsd: 0.08 });
await sleep(100);
const t = await human.call<{ records: Array<{ id: string }> }>('board_read', { section: 'tasks', projectId });
void t;
await human.call('human.post', { projectId, to: 'all', body: 'Keep the old cart behind a flag until QA signs off.' });
// A small plan and some talk: Max (chat-joined) leads briefly to commit Cy's proposals.
const maxClient = await h.agent();
const maxReq = await requestJoin(maxClient, { name: 'Max', client: 'codex' });
const maxCode = await human.call<{ code: string }>('pairing.allow', { requestId: maxReq.request.requestId, projectId });
const maxId = await confirmJoin(maxClient, maxReq, maxCode.code, Date.now());
await authenticate(maxClient, maxId);
await human.call('leader.assign', { projectId, agentId: maxId.agentId });
for (const title of ['Single-page cart layout', 'Inline address validation', 'Feature flag for the old cart', 'Checkout e2e tests']) {
  const t = await chat.call<{ ticketId: string }>('board_propose', { section: 'tasks', op: 'add', data: { title, criteria: ['works'] }, reason: 'goal' });
  await maxClient.call('board_commit', { ticketId: t.ticketId });
}
await human.call('leader.assign', { projectId, agentId: id.Lead });
await human.call('plan.approve', { projectId });
const tasks = await chat.call<{ records: Array<{ taskId: string }> }>('board_read', { section: 'tasks' });
await chat.call('claim', { taskId: tasks.records[0]!.taskId });
await chat.call('send', { to: [id.Ada], type: 'chat', body: 'I took the layout; can you take address validation?' });
await maxClient.call('send', { to: 'all', type: 'chat', body: 'Reviewing as soon as a change request is up.' });
await sleep(200);
proc('Bo').emit({ type: 'exit', code: 1, error: 'API Error: 529 overloaded' });
await sleep(50);

const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
const shots: Array<[string, string]> = [['overview', '#/overview'], ['agents', '#/agents'], ['project', `#/project/${encodeURIComponent(projectId)}/table`], ['board', `#/project/${encodeURIComponent(projectId)}/board`], ['pairing', '#/pairing']];
for (const scheme of ['dark', 'light'] as const) {
  for (const [w, hgt, label] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']] as const) {
    const context = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(h.loginUrl());
    for (const [name, hash] of shots) {
      await page.evaluate((x) => (location.hash = x), hash);
      await sleep(900);
      if (name === 'project') {
        await page.getByRole('button', { name: /^Ada,/ }).click();
        await sleep(1500);
        await page.locator('.log-tool').nth(2).locator('summary').click();
        await page.locator('.log-thinking').first().locator('summary').click();
        await sleep(300);
      }
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
