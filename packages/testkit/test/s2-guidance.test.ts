import { afterEach, describe, expect, it } from 'vitest';
import { McpAgent, SampleRepo, settle, TestHub, type PairedAgent } from '../src/index.ts';

let t: TestHub;
let repo: SampleRepo;
const agents: McpAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await t?.close();
  repo?.dispose();
});

const next = (a: PairedAgent) => a.client.call<{ tool: string; step: string }>('agent.next');

describe('the Round Table drives each agent: next steps from the board (D3)', () => {
  it('walks a leader and two workers through a whole task without any role prompt', async () => {
    t = await TestHub.start();
    repo = new SampleRepo();
    const lead = await t.pair('Lead', { newProjectName: 'P' });
    const projectId = lead.session.projectId;
    const a = await t.pair('Ada', { projectId });
    const b = await t.pair('Bo', { projectId });
    await t.human.call('leader.assign', { projectId, agentId: lead.identity.agentId });

    expect((await next(a)).step).toContain('no goal yet');
    await t.human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
    await t.human.call('rules.edit', { projectId, rules: { testCommand: 'sh test.sh' } });
    await t.human.call('goal.set', { projectId, goal: { objective: 'Say hello there' } });

    // Nothing planned: workers are told to propose, the leader to wait.
    expect(await next(a)).toMatchObject({ tool: 'board_propose', step: expect.stringContaining('Say hello there') });
    expect((await next(lead)).tool).toBe('wait');
    const { ticketId } = await a.client.call<{ ticketId: string }>('board_propose', { section: 'tasks', op: 'add', data: { title: 'Greeting', criteria: ['says hello there'] }, reason: 'goal' });

    // A proposal is waiting: the leader is told exactly which one; others stop proposing.
    expect(await next(lead)).toMatchObject({ tool: 'board_commit', step: expect.stringContaining(ticketId) });
    expect((await next(b)).tool).toBe('wait');
    const { committed: taskId } = await lead.client.call<{ committed: string }>('board_commit', { ticketId });
    expect((await next(lead)).step).toContain('human’s approval');

    await t.human.call('plan.approve', { projectId });
    expect(await next(a)).toMatchObject({ tool: 'claim', step: expect.stringContaining(taskId) });
    const { branch } = await a.client.call<{ branch: string }>('claim', { taskId });
    expect(await next(a)).toMatchObject({ tool: 'board_propose', step: expect.stringContaining(`git switch -c ${branch}`) });
    expect((await next(b)).tool).toBe('wait');

    const wt = repo.worktree();
    wt.branch(branch);
    const head = wt.commit('greeting.txt', 'hello there\n', 'done');
    const cr = await a.client.call<{ id: string }>('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId, branch }, reason: 'ready' });

    // The author is told whom to ask; the reviewer is told exactly what to check and how to answer.
    const ask = await next(a);
    expect(ask.tool).toBe('request');
    expect(ask.step).toContain(b.identity.agentId);
    const review = await a.client.call<{ requestId: string }>('request', { to: b.identity.agentId, kind: 'review', ref: cr.id });
    const test = await a.client.call<{ requestId: string }>('request', { to: b.identity.agentId, kind: 'test', ref: cr.id });
    expect((await next(a)).tool).toBe('wait');
    const toReview = await next(b);
    expect(toReview.tool).toBe('respond');
    expect(toReview.step).toContain(`git checkout --detach ${head}`);
    expect(toReview.step).toContain(review.requestId);

    await b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'changes_needed', headSha: head, notes: 'add a trailing newline check' } });
    expect(await next(a)).toMatchObject({ tool: 'board_propose', step: expect.stringContaining('add a trailing newline check') });
    expect((await next(b)).step).toContain(test.requestId);
  });

  it('says so in every MCP result: pairing hands control to the Round Table, role changes are explained', async () => {
    t = await TestHub.start();
    const a = await McpAgent.start(t, { slot: 'a' });
    agents.push(a);
    const requested = await a.call('join_request', { name: 'Ada' });
    const phrase = /match phrase: (\S+)/.exec(requested)?.[1];
    const { requests } = await t.human.call<{ requests: Array<{ requestId: string; matchPhrase: string }> }>('pairing.list');
    const { code, projectId } = await t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: requests.find((r) => r.matchPhrase === phrase)!.requestId, newProjectName: 'P' });
    const confirmed = await a.call('join_confirm', { code });
    expect(confirmed).toContain('the Round Table drives this session, not the chat');
    expect(confirmed).toMatch(/\[Round Table\] next: .*\n.*do not stop to chat/);

    // An empty wait still says what to do next, so the loop never stalls.
    expect(await a.call('wait', { timeoutMs: 10 })).toMatch(/No new messages\.\n\n\[Round Table\] next: /);

    // The human's message comes first.
    await t.human.call('human.post', { projectId, to: 'all', body: 'Please report your status.' });
    expect(await a.call('wait', { timeoutMs: 10 })).toContain('next: First do what the human asked above');

    const roster = await t.human.call<{ records: Array<{ agentId: string }> }>('board_read', { section: 'roster', projectId });
    await t.human.call('leader.assign', { projectId, agentId: roster.records[0]!.agentId });
    await settle();
    expect(await a.call('wait', { timeoutMs: 10 })).toContain('your role changed: you are now the leader. As the leader you coordinate only');
  });
});
