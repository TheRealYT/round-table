import { get } from 'node:http';
import { expect, test } from '@playwright/test';
import { authenticate, confirmJoin, requestJoin } from '@round-table/agent';
import { startHub } from './hub-fixture.ts';

type Hub = Awaited<ReturnType<typeof startHub>>;
let h: Hub;
test.beforeEach(async () => {
  h = await startHub();
});
test.afterEach(async () => h.close());

test('the human pairs an agent through the app and they exchange messages', async ({ page }) => {
  await page.goto(h.loginUrl());
  // Pairing shows in the sidebar only while a request waits; the page is always at #/pairing.
  await page.evaluate(() => { location.hash = '#/pairing'; });
  await expect(page.getByRole('heading', { name: 'Pairing' })).toBeVisible();
  await expect(page.getByText('No agents are waiting')).toBeVisible();

  // An agent asks to join; its request appears live, showing the phrase from the agent's chat.
  const agent = await h.agent();
  const pending = await requestJoin(agent, { name: 'Worker A', client: 'scripted', tags: ['backend'] });
  const card = page.locator('article.request', { hasText: pending.request.matchPhrase });
  await expect(card).toBeVisible();
  await expect(page.locator('.nav-item', { hasText: 'Pairing' }).locator('.count-badge')).toHaveText('1');

  await card.getByLabel('Project', { exact: true }).selectOption('new');
  await card.getByLabel('New project name').fill('Checkout redesign');
  await card.getByRole('button', { name: 'Phrase matches, allow' }).click();
  const code = (await page.getByTestId('pairing-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[0-9A-Z]{8}$/);

  // The human pastes the code into the agent's chat; the agent confirms and opens its session.
  const identity = await confirmJoin(agent, pending, code, Date.now());
  await authenticate(agent, identity);

  await page.getByRole('button', { name: 'Done, open project' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout redesign' })).toBeVisible();
  await page.getByRole('tab', { name: /Table/ }).click();
  // The conversation panel is open beside the page on a wide screen.
  await expect(page.getByRole('complementary', { name: 'Conversation' })).toBeVisible();
  const agentCard = page.locator('article.agent', { hasText: 'Worker A' });
  await expect(agentCard.getByText('working')).toBeVisible();

  // Human instruction: delivered at human priority to the agent's wait.
  await page.getByLabel('Instruction').fill('Please start with the cart page.');
  await page.getByLabel('Instruction').press('Control+Enter');
  const got = await agent.call<{ items: Array<{ role: string; priority: string; body: string }> }>('wait', { ack: [] });
  expect(got.items).toEqual([expect.objectContaining({ role: 'human', priority: 'human', body: 'Please start with the cart page.' })]);

  // The agent's activity and a message show up live in the feed.
  await agent.call('activity', { doing: 'reading the cart page', next: 'write a plan' });
  await expect(agentCard.getByText('reading the cart page')).toBeVisible();
  await agentCard.getByRole('button', { name: 'Make leader' }).click();
  await expect(agentCard.locator('.role')).toHaveText('leader');
  await expect(page.locator('.feed')).toContainText('Worker A is now leader');

  // Disconnect is visible right away (the hub sees the socket drop).
  agent.close();
  await expect(agentCard.getByText('reconnecting')).toBeVisible();
  await page.screenshot({ path: 'test-results/s1-project.png', fullPage: true });
});

test('a new chat asking to continue as a paired agent needs the human, and stays that agent', async ({ page }) => {
  await page.goto(h.loginUrl());
  // Pairing shows in the sidebar only while a request waits; the page is always at #/pairing.
  await page.evaluate(() => { location.hash = '#/pairing'; });
  const first = await h.agent();
  const pending = await requestJoin(first, { name: 'Ada', client: 'scripted' });
  const card = page.locator('article.request', { hasText: pending.request.matchPhrase });
  await card.getByLabel('New project name').fill('Resume check');
  await card.getByRole('button', { name: 'Phrase matches, allow' }).click();
  const code = (await page.getByTestId('pairing-code').textContent())?.trim() ?? '';
  const identity = await confirmJoin(first, pending, code, Date.now());
  await page.getByRole('button', { name: 'Done, open project' }).click();
  // Pairing shows in the sidebar only while a request waits; the page is always at #/pairing.
  await page.evaluate(() => { location.hash = '#/pairing'; });

  // Another chat, same key (the IDE's shared rt-agent), asks to be Ada.
  const second = await h.agent();
  const again = await requestJoin(second, { name: 'Ada', client: 'scripted' }, { publicKey: identity.publicKey, privateKey: identity.privateKey });
  const resume = page.locator('article.request', { hasText: again.request.matchPhrase });
  await expect(resume.getByRole('note')).toContainText('A new chat asks to continue as Ada');
  await expect(resume.getByLabel('Project', { exact: true })).toHaveCount(0);
  await resume.getByRole('button', { name: 'Phrase matches, allow as Ada' }).click();
  const code2 = (await page.getByTestId('pairing-code').textContent())?.trim() ?? '';
  const resumed = await confirmJoin(second, again, code2, Date.now());
  expect(resumed.agentId).toBe(identity.agentId);
  await expect(page.locator('table.table tbody tr')).toHaveCount(1);
});

test('without the login link the app shows how to log in', async ({ page }) => {
  await page.goto(h.base);
  await expect(page.getByText('You are not logged in to this hub.')).toBeVisible();
});

test('login links work once, and the hub refuses other Host names (DNS rebinding)', async ({ request }) => {
  const url = h.loginUrl();
  const first = await request.get(url, { maxRedirects: 0 });
  expect(first.status()).toBe(302);
  expect(first.headers()['set-cookie']).toContain('HttpOnly');
  expect((await request.get(url, { maxRedirects: 0 })).status()).toBe(403);
  // fetch() may not set Host, so use node:http, as a DNS-rebinding page's request would arrive.
  const status = await new Promise<number>((resolve, reject) => {
    const { port } = new URL(h.base);
    get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
  });
  expect(status).toBe(403);
});
