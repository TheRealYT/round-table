import { expect, test } from '@playwright/test';
import { FakeAgentHost, FakeDriver } from '@round-table/testkit';
import { startHub } from './hub-fixture.ts';

type Hub = Awaited<ReturnType<typeof startHub>>;
let h: Hub;
let driver: FakeDriver;
test.beforeEach(async () => {
  driver = new FakeDriver();
  h = await startHub({ agents: new FakeAgentHost(), drivers: { 'claude-code': driver } });
});
test.afterEach(async () => h.close());

test('the human sets up a provider, starts two agents from it and watches them at the table', async ({ page }) => {
  const human = await h.human();
  await human.call('project.create', { name: 'Checkout' });

  await page.goto(h.loginUrl());
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Claude Code/ }).click();
  await page.getByLabel('Model').fill('sonnet');
  await page.getByLabel('Agents at once').fill('2');
  await page.getByRole('button', { name: 'Add Claude Code' }).click();

  const card = page.locator('article.provider', { hasText: 'Claude Code' });
  await expect(card.getByText('fake 1.0')).toBeVisible();
  await card.getByRole('button', { name: 'Test sign-in' }).click();
  await expect(card.getByRole('status')).toContainText('Signed in and answering');

  await card.getByLabel('Names, one agent each').fill('Ada, Bo');
  await card.getByRole('button', { name: 'Start 2 agents' }).click();
  await expect(card.getByText('Started Ada, Bo')).toBeVisible();
  await expect.poll(() => driver.started.length).toBe(2);
  expect(driver.started[0]!.options.model).toBe('sonnet');
  await expect(card.locator('tbody tr')).toHaveCount(2);

  // A third would exceed the limit of 2.
  await card.getByLabel('Names, one agent each').fill('Cy');
  await card.getByRole('button', { name: 'Start 1 agent' }).click();
  await expect(card.getByText(/Cy: .*2 of 2/)).toBeVisible();

  // The table: seats with live status, and a transcript for the selected agent.
  await page.locator('.nav-item', { hasText: 'Checkout' }).click();
  const ada = page.getByRole('button', { name: /^Ada, worker, working/ });
  await expect(ada).toBeVisible();
  const proc = driver.started[0]!;
  proc.emit({ type: 'tool', name: 'mcp__roundtable__board_view', input: '{"view":"me"}' });
  proc.endTurn({ sessionCostUsd: 0.12 });
  await expect(page.getByRole('button', { name: /^Ada, worker, idle/ })).toBeVisible();
  await page.getByRole('button', { name: /^Ada, worker/ }).click();
  const detail = page.getByLabel('Ada details');
  await expect(detail.getByLabel('Ada transcript')).toContainText('board_view');
  await expect(detail).toContainText('$0.12');

  await detail.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: /^Ada, worker, stopped/ })).toBeVisible();
  expect(proc.stopped).toBe(true);
  await detail.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => driver.started.length).toBe(3);
  await page.screenshot({ path: 'test-results/s2b-table.png', fullPage: true });
});
