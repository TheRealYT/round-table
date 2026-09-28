import { expect, test } from '@playwright/test';
import { authenticate, confirmJoin, requestJoin } from '@round-table/agent';
import type { HubClient } from '@round-table/protocol';
import { SampleRepo } from '@round-table/testkit';
import { startHub } from './hub-fixture.ts';

type Hub = Awaited<ReturnType<typeof startHub>>;
let h: Hub;
let repo: SampleRepo;
test.beforeEach(async () => {
  h = await startHub();
  repo = new SampleRepo();
});
test.afterEach(async () => {
  await h.close();
  repo.dispose();
});

async function pair(human: HubClient, name: string, target: object): Promise<{ client: HubClient; agentId: string; projectId: string }> {
  const client = await h.agent();
  const pending = await requestJoin(client, { name, client: 'scripted' });
  const { code } = await human.call<{ code: string }>('pairing.allow', { requestId: pending.request.requestId, ...target });
  const identity = await confirmJoin(client, pending, code, Date.now());
  const session = await authenticate(client, identity);
  return { client, agentId: identity.agentId, projectId: session.projectId };
}

test('the human sets up the board in the app, approves the plan, and watches a task get merged', async ({ page }) => {
  const human = await h.human();
  const lead = await pair(human, 'Lead', { newProjectName: 'Greeting' });
  const a = await pair(human, 'Ada', { projectId: lead.projectId });
  const b = await pair(human, 'Bo', { projectId: lead.projectId });
  await human.call('leader.assign', { projectId: lead.projectId, agentId: lead.agentId });

  await page.goto(h.loginUrl());
  await page.locator('.nav-item', { hasText: 'Greeting' }).click();

  // Setup, all through the app.
  await page.getByLabel('Goal').fill('Make the greeting friendlier');
  await page.getByRole('button', { name: 'Set goal' }).click();
  await page.getByLabel('Repository path').fill(repo.path);
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByText(repo.path)).toBeVisible();
  await page.getByLabel('Check command').fill('sh test.sh');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.feed')).toContainText('rules added by you');

  // An agent proposes, the leader commits, the human approves the plan in the app.
  const proposal = await a.client.call<{ ticketId: string }>('board_propose', { section: 'tasks', op: 'add', data: { title: 'Say hello there', criteria: ['greeting.txt says hello there'] }, reason: 'goal' });
  await expect(page.getByText('1 proposal waiting for the leader')).toBeVisible();
  const { committed: taskId } = await lead.client.call<{ committed: string }>('board_commit', { ticketId: proposal.ticketId });
  await page.getByRole('button', { name: 'Approve plan (1 proposed)' }).click();
  await page.getByRole('tab', { name: /Board/ }).click();
  await expect(page.locator('.column[aria-label="ready"]')).toContainText('Say hello there');

  // Work, review, test; the hub merges after its own run.
  const { branch } = await a.client.call<{ branch: string }>('claim', { taskId });
  const wt = repo.worktree();
  wt.branch(branch);
  const head = wt.commit('greeting.txt', 'hello there\n', 'friendlier');
  const cr = await a.client.call<{ id: string }>('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId, branch }, reason: 'ready' });
  const review = await a.client.call<{ requestId: string }>('request', { to: b.agentId, kind: 'review', ref: cr.id });
  const testReq = await a.client.call<{ requestId: string }>('request', { to: b.agentId, kind: 'test', ref: cr.id });
  await expect(page.locator('.column[aria-label="in_review"]')).toContainText('Say hello there');
  await b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'approved', headSha: head, notes: '' } });
  await b.client.call('respond', { requestId: testReq.requestId, result: { kind: 'test', status: 'pass', headSha: head, evidence: 'ok' } });

  await expect(page.locator('.column[aria-label="done"]')).toContainText('Say hello there', { timeout: 15_000 });
  await page.getByRole('tab', { name: /Changes/ }).click();
  const row = page.locator('table.changes tbody tr');
  await expect(row.locator('.verdict.ok')).toHaveCount(2);
  await expect(row).toContainText('Bo');
  await expect(row.locator('.chip', { hasText: 'pass' })).toBeVisible();
  await expect(row).toContainText('merged');
  expect(repo.fileOnMain('greeting.txt')).toBe('hello there');
  await page.screenshot({ path: 'test-results/s2-board.png', fullPage: true });

  // Code: the task's branch, what it changed, and the merge in the history.
  await page.getByRole('tab', { name: /Code/ }).click();
  const branchRow = page.locator('.git-list .git-row').filter({ has: page.getByText(branch, { exact: true }) });
  await expect(branchRow).toContainText('Say hello there');
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('.history .git-row', { hasText: 'friendlier' }).click();
  await expect(page.locator('.diff-lines tr.add')).toContainText('hello there');

  // The terminal: a shell in the repository.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.term-host').click();
  await page.keyboard.type('echo term-$((6*7))\n');
  await expect(page.locator('.term-host .xterm-rows')).toContainText('term-42', { timeout: 15_000 });
});

test('the app flags an agent whose model stopped calling tools, louder when work waits for it', async ({ page }) => {
  const human = await h.human();
  const lead = await pair(human, 'Lead', { newProjectName: 'Idle check' });
  const a = await pair(human, 'Ada', { projectId: lead.projectId });
  await human.call('leader.assign', { projectId: lead.projectId, agentId: lead.agentId });
  await human.call('goal.set', { projectId: lead.projectId, goal: { objective: 'Anything' } });
  await lead.client.call('agent.next');
  void a;

  await page.clock.install();
  await page.goto(h.loginUrl());
  await page.locator('.nav-item', { hasText: 'Idle check' }).click();
  await page.getByRole('tab', { name: /Table/ }).click();
  const card = page.locator('article.agent').filter({ has: page.getByText('Lead', { exact: true }) });
  await expect(card.getByText('working')).toBeVisible();
  await expect(card.locator('.nudge')).toHaveCount(0);

  // Two minutes without a tool call: the leader's next step is real work (plan the goal).
  await page.clock.fastForward('02:00');
  await expect(card.locator('.status')).toHaveText('stopped');
  await expect(card.locator('.nudge.urgent')).toContainText('Type “continue” in its chat');
  await expect(card.locator('.nudge')).toContainText('Work is waiting for it');
});
