import { afterEach, describe, expect, it } from 'vitest';
import { FakeAgentHost, FakeDriver, McpAgent, TestHub } from '../src/index.ts';

let t: TestHub;
const agents: McpAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await t?.close();
});

const CLAUDE = { kind: 'claude-code', label: 'Claude Code', command: '', auth: 'cli-login', model: 'sonnet', extraArgs: [], maxInstances: 5 } as const;
type Resolved = { resolved: { autonomy: { planApproval: string }; budget: { projectUsd: number }; rules: { team: string } }; hub: object; project: object };

describe('settings (S2c): hub-wide, overridden per project', () => {
  it('resolves defaults, then the hub, then the project', async () => {
    t = await TestHub.start();
    const { projectId } = await t.human.call<{ projectId: string }>('project.create', { name: 'P' });
    await t.human.call('settings.set', { scope: 'hub', overrides: { autonomy: { planApproval: 'leader' }, budget: { projectUsd: 5 } } });
    await t.human.call('settings.set', { scope: 'project', projectId, overrides: { budget: { projectUsd: 2 } } });
    const s = await t.human.call<Resolved>('settings.get', { projectId });
    expect(s.resolved.autonomy.planApproval).toBe('leader');
    expect(s.resolved.budget.projectUsd).toBe(2);
    expect(s.project).toEqual({ budget: { projectUsd: 2 } });
    const hubOnly = await t.human.call<Resolved>('settings.get', {});
    expect(hubOnly.resolved.budget.projectUsd).toBe(5);
    await expect(t.human.call('settings.set', { scope: 'hub', overrides: { autonomy: { planApproval: 'robots' } } })).rejects.toThrow();
  });

  it('full auto: the leader’s commit approves the plan, and free workers are told to claim', async () => {
    t = await TestHub.start();
    const lead = await t.pair('Lead', { newProjectName: 'P' });
    const projectId = lead.session.projectId;
    const ada = await t.pair('Ada', { projectId });
    await t.human.call('leader.assign', { projectId, agentId: lead.identity.agentId });
    await t.human.call('settings.set', { scope: 'project', projectId, overrides: { autonomy: { planApproval: 'leader' } } });
    await t.human.call('goal.set', { projectId, goal: { objective: 'Say hello' } });
    const { ticketId } = await lead.client.call<{ ticketId: string }>('board_propose', { section: 'tasks', op: 'add', data: { title: 'Greeting', criteria: ['says hello'] }, reason: 'goal' });
    const { committed } = await lead.client.call<{ committed: string }>('board_commit', { ticketId });
    expect(t.hub.model.projects[projectId as never]!.tasks[committed as never]!.status).toBe('ready');
    const inbox = await ada.client.call<{ messages: Array<{ body: string }> }>('wait', { timeoutMs: 10 });
    expect(JSON.stringify(inbox)).toContain('The leader approved the plan: 1 task is ready');
  });

  it('refuses a worker’s message to everyone when the project turned that off', async () => {
    t = await TestHub.start();
    const lead = await t.pair('Lead', { newProjectName: 'P' });
    const projectId = lead.session.projectId;
    const ada = await t.pair('Ada', { projectId });
    await t.human.call('settings.set', { scope: 'project', projectId, overrides: { messaging: { workerBroadcast: 'off' } } });
    await expect(ada.client.call('send', { to: 'all', type: 'chat', body: 'hi all' })).rejects.toThrow(/name the agents/);
    await expect(ada.client.call('send', { to: [lead.identity.agentId], type: 'chat', body: 'hi' })).resolves.toBeTruthy();
  });

  it('warns at 80% of the budget and stops the project’s hub-run agents at 100%', async () => {
    const driver = new FakeDriver();
    t = await TestHub.start({ agentHost: new FakeAgentHost(), drivers: { 'claude-code': driver } });
    const { projectId } = await t.human.call<{ projectId: string }>('project.create', { name: 'P' });
    const { providerId } = await t.human.call<{ providerId: string }>('provider.save', { settings: CLAUDE });
    await t.human.call('settings.set', { scope: 'project', projectId, overrides: { budget: { projectUsd: 1 } } });
    const { started } = await t.human.call<{ started: Array<{ agentId: string }> }>('agent.spawn', { projectId, providerId, names: ['Ada', 'Bo'] });
    await expect.poll(() => driver.started.length).toBe(2);
    const ada = driver.of(started[0]!.agentId)!;
    ada.endTurn({ sessionCostUsd: 0.85 });
    await expect.poll(() => t.hub.model.projects[projectId as never]!.budget?.warned).toBe(true);
    expect(t.hub.model.agents[started[1]!.agentId as never]!.driven!.run).toBe(true);
    driver.of(started[1]!.agentId)!.endTurn({ sessionCostUsd: 0.2 });
    await expect.poll(() => t.hub.model.projects[projectId as never]!.budget?.reached).toBe(true);
    for (const s of started) expect(t.hub.model.agents[s.agentId as never]!.driven!.run).toBe(false);

    // The human's inbox says so, first.
    const inbox = await t.human.call<{ items: Array<{ kind: string; urgent: boolean; title: string }> }>('inbox.list', {});
    expect(inbox.items[0]).toMatchObject({ kind: 'budget', urgent: true, title: 'P reached its budget' });
  });

  it('lists what needs the human: plans to approve and pairing requests', async () => {
    t = await TestHub.start();
    const lead = await t.pair('Lead', { newProjectName: 'Plan me' });
    const projectId = lead.session.projectId;
    await t.human.call('leader.assign', { projectId, agentId: lead.identity.agentId });
    await t.human.call('goal.set', { projectId, goal: { objective: 'x' } });
    const { ticketId } = await lead.client.call<{ ticketId: string }>('board_propose', { section: 'tasks', op: 'add', data: { title: 'T', criteria: ['c'] }, reason: 'r' });
    await lead.client.call('board_commit', { ticketId });
    const inbox = await t.human.call<{ items: Array<{ kind: string; title: string; detail: string }> }>('inbox.list', {});
    expect(inbox.items).toContainEqual(expect.objectContaining({ kind: 'plan', title: 'Approve the plan in Plan me', detail: '1 task proposed' }));
    await t.human.call('plan.approve', { projectId });
    expect((await t.human.call<{ items: unknown[] }>('inbox.list', {})).items).toEqual([]);
  });

  it('gives hub-run agents the team rules, and the leader its own rules too', async () => {
    const driver = new FakeDriver();
    t = await TestHub.start({ agentHost: new FakeAgentHost(), drivers: { 'claude-code': driver } });
    const { projectId } = await t.human.call<{ projectId: string }>('project.create', { name: 'P' });
    const { providerId } = await t.human.call<{ providerId: string }>('provider.save', { settings: CLAUDE });
    await t.human.call('settings.set', { scope: 'hub', overrides: { rules: { team: 'Use TypeScript.', leader: 'Plan at most 3 tasks.' } } });
    await t.human.call('rules.edit', { projectId, rules: { testCommand: 'npm test', text: 'No new dependencies.', leaderText: 'Ask the human before adding scope.' } });
    const { started } = await t.human.call<{ started: Array<{ agentId: string }> }>('agent.spawn', { projectId, providerId, names: ['Lead', 'Ada'], leader: 'Lead' });
    await expect.poll(() => driver.started.length).toBe(2);
    const lead = driver.of(started[0]!.agentId)!.sent[0]!;
    const ada = driver.of(started[1]!.agentId)!;
    expect(lead).toContain('Use TypeScript.');
    expect(lead).toContain('No new dependencies.');
    expect(lead).toContain('Plan at most 3 tasks.');
    expect(lead).toContain('Ask the human before adding scope.');
    expect(ada.sent[0]).toContain('No new dependencies.');
    expect(ada.sent[0]).not.toContain('Plan at most 3 tasks.');

    // A change reaches running agents with their next turn.
    ada.endTurn();
    await t.human.call('settings.set', { scope: 'hub', overrides: { rules: { team: 'Use TypeScript and tabs.' } } });
    await t.human.call('human.post', { projectId, to: [started[1]!.agentId], body: 'go on' });
    await expect.poll(() => ada.sent.length).toBe(2);
    expect(ada.last).toContain('The human changed the rules');
    expect(ada.last).toContain('Use TypeScript and tabs.');
  });
});
