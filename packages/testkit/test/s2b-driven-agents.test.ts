import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@round-table/hub';
import { FakeAgentHost, FakeDriver, TestHub } from '../src/index.ts';

let t: TestHub;
afterEach(async () => t?.close());

const CLAUDE = { kind: 'claude-code', label: 'Claude Code', command: '', auth: 'cli-login', model: 'sonnet', extraArgs: [], maxInstances: 3 } as const;

async function setup(options: { secrets?: MemorySecretStore } = {}) {
  const driver = new FakeDriver();
  const host = new FakeAgentHost();
  t = await TestHub.start({ agentHost: host, drivers: { 'claude-code': driver }, ...(options.secrets && { secrets: options.secrets }) });
  const { projectId } = await t.human.call<{ projectId: string }>('project.create', { name: 'P' });
  const { providerId } = await t.human.call<{ providerId: string }>('provider.save', { settings: CLAUDE });
  return { driver, host, projectId, providerId };
}

type Live = { status: string; lastError: string | null };
type Row = { agentId: string; name: string; driven: { run: boolean; turns: number; costUsd: number; live: Live } | null };
const roster = (projectId: string) => t.human.call<{ records: Row[] }>('board_read', { section: 'roster', projectId }).then((r) => r.records);
const live = async (projectId: string, name: string) => (await roster(projectId)).find((r) => r.name === name)?.driven?.live.status;

async function spawn(projectId: string, providerId: string, names: string[]) {
  const out = await t.human.call<{ started: Array<{ name: string; agentId: string }>; failed: Array<{ name: string; error: string }> }>('agent.spawn', { projectId, providerId, names });
  return out;
}

describe('providers (ADR-0018)', () => {
  it('keeps credentials out of the log, and says only whether one is set', async () => {
    const secrets = new MemorySecretStore();
    const { providerId } = await setup({ secrets });
    await t.human.call('provider.save', { providerId, settings: { ...CLAUDE, auth: 'api-key' } });
    await t.human.call('provider.secret', { providerId, value: 'sk-very-secret-123' });
    const list = await t.human.call<{ providers: Array<{ providerId: string; hasSecret: boolean; settings: { auth: string } }> }>('provider.list');
    expect(list.providers).toEqual([expect.objectContaining({ providerId, hasSecret: true, settings: expect.objectContaining({ auth: 'api-key' }) })]);
    expect(secrets.get(providerId)).toBe('sk-very-secret-123');
    expect(JSON.stringify([...t.hub.store.all()])).not.toContain('sk-very-secret');
    expect(JSON.stringify(list)).not.toContain('sk-very-secret');
    await t.human.call('provider.secret', { providerId, value: null });
    expect(secrets.get(providerId)).toBeUndefined();
  });

  it('passes custom environment variables to the agents; secret ones stay out of the log', async () => {
    const secrets = new MemorySecretStore();
    const { driver, projectId, providerId } = await setup({ secrets });
    const settings = { ...CLAUDE, env: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://llm.internal.example/v1' }], secretEnv: ['ANTHROPIC_AUTH_TOKEN'] };
    await t.human.call('provider.save', { providerId, settings });
    expect((await spawn(projectId, providerId, ['Ada'])).failed[0]!.error).toContain('ANTHROPIC_AUTH_TOKEN');

    await t.human.call('provider.secret', { providerId, name: 'ANTHROPIC_AUTH_TOKEN', value: 'tok-very-secret-9' });
    await expect(t.human.call('provider.secret', { providerId, name: 'OTHER', value: 'x' })).rejects.toThrow('isn’t one of this provider’s secret variables');
    const list = await t.human.call<{ providers: Array<{ secretsSet: string[] }> }>('provider.list');
    expect(list.providers[0]!.secretsSet).toEqual(['ANTHROPIC_AUTH_TOKEN']);

    expect((await spawn(projectId, providerId, ['Ada'])).started).toHaveLength(1);
    await expect.poll(() => driver.started.length).toBe(1);
    expect(driver.started[0]!.options.env).toEqual({ ANTHROPIC_BASE_URL: 'https://llm.internal.example/v1', ANTHROPIC_AUTH_TOKEN: 'tok-very-secret-9' });
    expect(JSON.stringify([...t.hub.store.all()])).not.toContain('tok-very-secret');
    expect(JSON.stringify([...t.hub.store.all()])).toContain('llm.internal.example'); // plain variables are settings, in the log

    // No longer secret: its stored value is deleted.
    await t.human.call('provider.save', { providerId, settings: { ...settings, secretEnv: [] } });
    expect(secrets.get(`${providerId}:ANTHROPIC_AUTH_TOKEN`)).toBeUndefined();
    await expect(t.human.call('provider.save', { providerId, settings: { ...settings, env: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: 'x' }] } })).rejects.toThrow('set twice');
    await expect(t.human.call('provider.save', { providerId, settings: { ...settings, env: [{ name: '1BAD', value: 'x' }] } })).rejects.toThrow();
  });

  it('refuses to start agents it can’t run properly', async () => {
    const { projectId, providerId } = await setup();
    const { providerId: codex } = await t.human.call<{ providerId: string }>('provider.save', { settings: { ...CLAUDE, kind: 'codex', label: 'Codex' } });
    expect((await spawn(projectId, codex, ['Ada'])).failed[0]!.error).toContain('driver hasn’t passed the check');

    await t.human.call('provider.save', { providerId, settings: { ...CLAUDE, auth: 'api-key', maxInstances: 2 } });
    expect((await spawn(projectId, providerId, ['Ada'])).failed[0]!.error).toContain('none is set');
    await t.human.call('provider.save', { providerId, settings: { ...CLAUDE, maxInstances: 2 } });
    const out = await spawn(projectId, providerId, ['Ada', 'Bo', 'Cy', 'ada']);
    expect(out.started.map((s) => s.name)).toEqual(['Ada', 'Bo']);
    expect(out.failed.map((f) => f.name)).toEqual(['Cy', 'ada']);
    expect(out.failed[0]!.error).toContain('2 of 2');
  });
});

describe('the supervisor runs the agents (ADR-0018)', () => {
  it('starts each agent from one provider, with its own identity and folder, and tells it who it is', async () => {
    const { driver, host, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada', 'Bo']);
    await expect.poll(() => driver.started.length).toBe(2);
    expect(host.provisioned.map((p) => p.name)).toEqual(['Ada', 'Bo']);
    const ada = driver.of(started[0]!.agentId)!;
    expect(ada.options).toMatchObject({ model: 'sonnet', resumeSessionId: null, cwd: `/fake/work/${started[0]!.agentId}` });
    expect(ada.options.systemPrompt).toContain('You are Ada');
    expect(ada.last).toContain('You are Ada, the worker on project "P"');
    expect(ada.last).toContain('Goal: not set yet');
    expect(await live(projectId, 'Ada')).toBe('working');

    ada.emit({ type: 'session', sessionId: 'sess-ada' });
    ada.endTurn({ sessionCostUsd: 0.25 });
    await expect.poll(() => live(projectId, 'Ada')).toBe('idle');
    const row = (await roster(projectId)).find((r) => r.name === 'Ada')!;
    expect(row.driven).toMatchObject({ run: true, turns: 1, costUsd: 0.25 });
    expect(t.hub.model.agents[started[0]!.agentId as never]!.driven!.cliSessionId).toBe('sess-ada');
  });

  it('wakes an idle agent with its messages as the next turn, and acks them when the turn ends', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada']);
    await expect.poll(() => driver.started.length).toBe(1);
    const ada = driver.of(started[0]!.agentId)!;
    ada.endTurn();
    await expect.poll(() => live(projectId, 'Ada')).toBe('idle');

    await t.human.call('human.post', { projectId, to: 'all', body: 'Start with the README.' });
    await expect.poll(() => ada.sent.length).toBe(2);
    expect(ada.last).toContain('HUMAN message from the human (human): Start with the README.');
    expect(ada.last).toContain('outrank the board');
    expect(await live(projectId, 'Ada')).toBe('working');

    ada.endTurn();
    await expect.poll(() => live(projectId, 'Ada')).toBe('idle');
    await new Promise((r) => setTimeout(r, 20));
    expect(ada.sent).toHaveLength(2); // acked: not sent again
  });

  it('starts the named agent as the leader, so its first turn already plans', async () => {
    const { driver, projectId, providerId } = await setup();
    await t.human.call('goal.set', { projectId, goal: { objective: 'Build tic-tac-toe' } });
    const { started } = await t.human.call<{ started: Array<{ name: string; agentId: string }> }>('agent.spawn', { projectId, providerId, names: ['Lead', 'Ada'], leader: 'Lead' });
    await expect.poll(() => driver.started.length).toBe(2);
    const lead = driver.of(started[0]!.agentId)!;
    const ada = driver.of(started[1]!.agentId)!;
    expect(lead.sent[0]).toContain('You are Lead, the leader');
    expect(lead.sent[0]).toContain('Plan the goal "Build tic-tac-toe" yourself');
    expect(ada.sent[0]).toContain('The leader is drafting the plan');
    expect(t.hub.model.projects[projectId as never]!.leaderId).toBe(started[0]!.agentId);
  });

  it('runs each agent with its own model and effort, and restarts an idle agent (resuming) when they change', async () => {
    const { driver, projectId, providerId } = await setup();
    await t.human.call('provider.save', { providerId, settings: { ...CLAUDE, effort: 'medium' } });
    const bad = await spawn(projectId, providerId, ['Ada']).catch((e: Error) => e);
    expect(bad).not.toBeInstanceOf(Error);
    const rejected = await t.human.call('agent.spawn', { projectId, providerId, names: ['Bo'], effort: 'turbo' }).then((r) => r as { failed: Array<{ error: string }> });
    expect(rejected.failed[0]!.error).toContain('effort must be one of low, medium, high, xhigh, max');
    await expect.poll(() => driver.started.length).toBe(1);
    const agentId = (bad as { started: Array<{ agentId: string }> }).started[0]!.agentId;
    const first = driver.of(agentId)!;
    expect(first.options).toMatchObject({ model: 'sonnet', effort: 'medium' });
    expect(first.options.mcp.args).toEqual(expect.arrayContaining(['--tools', 'dynamic'])); // Claude Code follows list_changed
    first.emit({ type: 'session', sessionId: 'sess-ada' });
    first.endTurn();
    await expect.poll(() => live(projectId, 'Ada')).toBe('idle');

    await t.human.call('agent.configure', { projectId, agentId, model: 'opus', effort: 'max' });
    await expect.poll(() => driver.started.length).toBe(2);
    expect(first.stopped).toBe(true);
    expect(driver.of(agentId)!.options).toMatchObject({ model: 'opus', effort: 'max', resumeSessionId: 'sess-ada' });
  });

  it('wakes agents only for messages meant for them: a worker’s message to everyone rides along with their next turn', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada', 'Bo']);
    await expect.poll(() => driver.started.length).toBe(2);
    const [adaId, boId] = started.map((s) => s.agentId) as [string, string];
    const ada = driver.of(adaId)!;
    const bo = driver.of(boId)!;
    ada.endTurn();
    bo.endTurn();
    await expect.poll(() => live(projectId, 'Bo')).toBe('idle');
    const asAda = { kind: 'worker', agentId: adaId, projectId, epoch: 1 };

    // Ada tells everyone (even at direct): Bo isn't woken for it.
    expect(t.hub.bus.dispatch('send', { to: 'all', type: 'chat', body: 'FYI: I use tabs.', priority: 'direct' }, asAda as never).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(bo.sent).toHaveLength(1);

    // A message to Bo by name wakes him, and the FYI comes along in the same turn.
    t.hub.bus.dispatch('send', { to: [boId], type: 'chat', body: 'Can you review my branch?', priority: 'normal' }, asAda as never);
    await expect.poll(() => bo.sent.length).toBe(2);
    expect(bo.last).toContain('message from Ada (chat): Can you review my branch?');
    expect(bo.last).toContain('FYI: I use tabs.');
    const steps = await t.human.call<{ entries: Array<{ kind: string; data: { trigger?: string } | null }> }>('agent.transcript', { projectId, agentId: boId });
    expect(steps.entries.filter((e) => e.kind === 'to_agent').map((e) => e.data?.trigger)).toEqual(['kickoff', 'agent']);
  });

  it('gives an idle agent the work the board has for it, but doesn’t nag when it doesn’t move', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada']);
    await expect.poll(() => driver.started.length).toBe(1);
    const ada = driver.of(started[0]!.agentId)!;
    ada.endTurn();
    await expect.poll(() => live(projectId, 'Ada')).toBe('idle');
    expect(ada.sent).toHaveLength(1); // no goal: nothing to do

    await t.human.call('goal.set', { projectId, goal: { objective: 'Say hello' } });
    await expect.poll(() => ada.sent.length).toBe(2);
    expect(ada.last).toContain('The human set the goal: Say hello');
    expect(ada.last).toContain('[Round Table] next: No tasks exist yet for the goal "Say hello"');
    ada.endTurn();
    await expect.poll(() => ada.sent.length).toBe(3); // asked once more
    ada.endTurn();
    await new Promise((r) => setTimeout(r, 30));
    expect(ada.sent).toHaveLength(3); // then left idle for the human to see
  });

  it('keeps every step of the session — thinking, tool calls with inputs and results, text — and pages through it', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada']);
    const agentId = started[0]!.agentId;
    await expect.poll(() => driver.started.length).toBe(1);
    const ada = driver.started[0]!;
    ada.emit({ type: 'thinking', text: 'The goal needs a task list first.' });
    ada.emit({ type: 'tool', id: 't1', name: 'Read', input: '{"file_path":"/repo/README.md"}' });
    ada.emit({ type: 'tool_result', id: 't1', output: '# sample\n', isError: false });
    ada.emit({ type: 'tool', id: 't2', name: 'Bash', input: '{"command":"npm test"}' });
    ada.emit({ type: 'tool_result', id: 't2', output: '1 failing', isError: true });
    ada.emit({ type: 'text', text: 'Proposing the first task.' });
    ada.endTurn({ sessionCostUsd: 0.05 });
    type Step = { id: number; kind: string; text: string; data: Record<string, unknown> | null };
    const all = await t.human.call<{ entries: Step[] }>('agent.transcript', { projectId, agentId });
    expect(all.entries.map((e) => e.kind)).toEqual(['status', 'to_agent', 'thinking', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'turn']);
    expect(all.entries[3]).toMatchObject({ kind: 'tool', text: 'Read', data: { id: 't1', name: 'Read', input: '{"file_path":"/repo/README.md"}' } });
    expect(all.entries[6]).toMatchObject({ kind: 'tool_result', text: '1 failing', data: { id: 't2', isError: true } });
    expect(all.entries[8]).toMatchObject({ kind: 'turn', data: { ok: true, costUsd: 0.05, tokens: 110 } });

    ada.emit({ type: 'text', text: 'One more thing.' });
    const newer = await t.human.call<{ entries: Step[] }>('agent.transcript', { projectId, agentId, after: all.entries.at(-1)!.id });
    expect(newer.entries.map((e) => e.text)).toEqual(['One more thing.']);
    const latest = await t.human.call<{ entries: Step[] }>('agent.transcript', { projectId, agentId, limit: 2 });
    expect(latest.entries.map((e) => e.kind)).toEqual(['turn', 'text']);
  });

  it('tells an agent when its role changes, as its next turn', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Lead']);
    await expect.poll(() => driver.started.length).toBe(1);
    const lead = driver.started[0]!;
    expect(lead.last).toContain('the worker on project');
    await t.human.call('leader.assign', { projectId, agentId: started[0]!.agentId });
    lead.endTurn();
    await expect.poll(() => lead.sent.length).toBe(2);
    expect(lead.last).toContain('Your role changed: you are now the leader');
    expect(lead.last).toContain('You never write code');
  });

  it('restarts a crashed agent by resuming its session, and gives up after the backoff runs out', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada']);
    await expect.poll(() => driver.started.length).toBe(1);
    driver.started[0]!.emit({ type: 'session', sessionId: 'sess-1' });
    driver.started[0]!.emit({ type: 'exit', code: 1, error: 'boom' });
    expect(await live(projectId, 'Ada')).toBe('crashed');
    await expect.poll(() => driver.started.length).toBe(2);
    expect(driver.started[1]!.options.resumeSessionId).toBe('sess-1');
    expect(driver.started[1]!.last).toContain('The Round Table restarted you');

    driver.started[1]!.emit({ type: 'exit', code: 1, error: 'boom' });
    await expect.poll(() => driver.started.length).toBe(3);
    driver.started[2]!.emit({ type: 'exit', code: 1, error: 'boom again' });
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.started).toHaveLength(3); // two retries (test backoff), then it waits for the human
    const row = (await roster(projectId)).find((r) => r.name === 'Ada')!;
    expect(row.driven!.live).toMatchObject({ status: 'crashed', lastError: 'boom again' });

    await t.human.call('agent.run', { projectId, agentId: started[0]!.agentId, run: true });
    await expect.poll(() => driver.started.length).toBe(4);
  });

  it('stops, interrupts and starts again on the human’s command, and resumes after a hub restart', async () => {
    const { driver, projectId, providerId } = await setup();
    const { started } = await spawn(projectId, providerId, ['Ada']);
    const agentId = started[0]!.agentId;
    await expect.poll(() => driver.started.length).toBe(1);
    const first = driver.started[0]!;
    first.emit({ type: 'session', sessionId: 'sess-a' });

    expect(await t.human.call('agent.interrupt', { projectId, agentId })).toEqual({ ok: true });
    expect(first.interrupts).toBe(1);

    await t.human.call('agent.run', { projectId, agentId, run: false });
    expect(first.stopped).toBe(true);
    expect(await live(projectId, 'Ada')).toBe('stopped');

    await t.human.call('agent.run', { projectId, agentId, run: true });
    await expect.poll(() => driver.started.length).toBe(2);
    expect(driver.started[1]!.options.resumeSessionId).toBe('sess-a');

    const transcript = await t.human.call<{ entries: Array<{ kind: string; text: string }> }>('agent.transcript', { projectId, agentId });
    expect(transcript.entries.map((e) => e.kind)).toContain('to_agent');
    expect(transcript.entries.some((e) => e.text.includes('interrupted by the human'))).toBe(true);
  });
});
