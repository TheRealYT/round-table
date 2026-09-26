import { afterEach, describe, expect, it } from 'vitest';
import { HubError } from '@round-table/agent';
import { evolve, initialModel } from '@round-table/core';
import { SampleRepo, TestHub, type PairedAgent, type Worktree } from '../src/index.ts';

let t: TestHub;
let repo: SampleRepo;
afterEach(async () => {
  await t?.close();
  repo?.dispose();
});

async function rejects(p: Promise<unknown>): Promise<HubError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

type Msg = { deliveryId: number; from: string; role: string; priority: string; type: string; body: string; ref: string | null };
async function inbox(agent: PairedAgent): Promise<Msg[]> {
  const out = await agent.client.call<{ items: Msg[] }>('wait', { ack: [], timeoutMs: 10 });
  await agent.client.call('wait', { ack: out.items.map((i) => i.deliveryId), timeoutMs: 1 });
  return out.items;
}

interface Team {
  projectId: string;
  lead: PairedAgent;
  a: PairedAgent;
  b: PairedAgent;
  wtA: Worktree;
}

/** Leader + two workers on a project with the sample repo attached, rules and goal set by the human. */
async function team(): Promise<Team> {
  t = await TestHub.start();
  repo = new SampleRepo();
  const lead = await t.pair('Lead', { newProjectName: 'Greeting' });
  const projectId = lead.session.projectId;
  const a = await t.pair('A', { projectId });
  const b = await t.pair('B', { projectId });
  await t.human.call('leader.assign', { projectId, agentId: lead.identity.agentId });
  await t.human.call('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
  await t.human.call('rules.edit', { projectId, rules: { testCommand: 'sh test.sh', testTimeoutSec: 30 } });
  await t.human.call('goal.set', { projectId, goal: { objective: 'Make the greeting friendlier', successCriteria: ['greeting says hello there'] } });
  return { projectId, lead, a, b, wtA: repo.worktree() };
}

/** A proposes the task, the leader commits it, the human approves the plan, A claims it. */
async function readyAndClaimed(tm: Team): Promise<{ taskId: string; branch: string }> {
  const proposed = await tm.a.client.call<{ ticketId: string; routedTo: string }>('board_propose', {
    section: 'tasks',
    op: 'add',
    data: { title: 'Friendlier greeting', criteria: ['greeting.txt says "hello there"'] },
    reason: 'the goal asks for it',
  });
  expect(proposed.routedTo).toBe('leader');
  const toLeader = await inbox(tm.lead);
  expect(toLeader.find((m) => m.ref === proposed.ticketId)?.body).toContain('proposes add on tasks');
  const { committed: taskId } = await tm.lead.client.call<{ committed: string }>('board_commit', { ticketId: proposed.ticketId });
  expect((await rejects(tm.a.client.call('claim', { taskId }))).rejection).toBe('not_ready');
  await t.human.call('plan.approve', { projectId: tm.projectId });
  const claimed = await tm.a.client.call<{ branch: string }>('claim', { taskId });
  return { taskId, branch: claimed.branch };
}

async function taskStatus(tm: Team, taskId: string): Promise<string> {
  const out = await t.human.call<{ record: { status: string } }>('board_get', { projectId: tm.projectId, id: taskId });
  return out.record.status;
}

describe('S2: a task from proposal to merged', () => {
  it('goes proposed → ready → claimed → in_progress → in_review → in_test → done, merged by the hub after its own test run', async () => {
    const tm = await team();
    const { taskId, branch } = await readyAndClaimed(tm);
    expect(await taskStatus(tm, taskId)).toBe('claimed');

    // The leader coordinates only.
    expect((await rejects(tm.lead.client.call('claim', { taskId }))).code).toBe('forbidden');

    tm.wtA.branch(branch);
    const head = tm.wtA.commit('greeting.txt', 'hello there\n', 'friendlier greeting');
    const opened = await tm.a.client.call<{ id: string; headSha: string }>('board_propose', {
      section: 'artifacts',
      op: 'open',
      data: { kind: 'change_request', taskId, branch },
      reason: 'ready for review',
    });
    expect(opened.headSha).toBe(head);
    expect(await taskStatus(tm, taskId)).toBe('in_progress');

    // Nobody reviews their own work, and the leader never reviews.
    expect((await rejects(tm.a.client.call('request', { to: tm.a.identity.agentId, kind: 'review', ref: opened.id }))).rejection).toBe('self_review');
    expect((await rejects(tm.a.client.call('request', { to: tm.lead.identity.agentId, kind: 'review', ref: opened.id }))).rejection).toBe('leader_cannot_review');

    const review = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'review', ref: opened.id });
    const test = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'test', ref: taskId });
    expect(await taskStatus(tm, taskId)).toBe('in_review');
    const asks = await inbox(tm.b);
    expect(asks.filter((m) => m.type === 'request')).toHaveLength(2);

    await tm.b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'approved', headSha: head, notes: 'looks good' } });
    expect(await taskStatus(tm, taskId)).toBe('in_test');
    const mainBefore = repo.main();
    await tm.b.client.call('respond', { requestId: test.requestId, result: { kind: 'test', status: 'pass', headSha: head, evidence: 'sh test.sh passes on the branch' } });

    await t.hub.merges.idle();
    expect(await taskStatus(tm, taskId)).toBe('done');
    expect(repo.fileOnMain('greeting.txt')).toBe('hello there');
    expect(repo.main()).not.toBe(mainBefore);
    const quality = await t.human.call<{ records: Array<{ status: string; outputTail: string }> }>('board_read', { projectId: tm.projectId, section: 'quality' });
    expect(quality.records).toEqual([expect.objectContaining({ status: 'pass', outputTail: expect.stringContaining('tests pass') })]);
    expect((await inbox(tm.a)).some((m) => m.body.includes('is done: merged into main'))).toBe(true);

    // Everything in the model can be rebuilt from the log (invariant 2) and the task's history is on record.
    const rebuilt = initialModel();
    for (const row of t.hub.store.all()) evolve(rebuilt, row);
    expect(rebuilt).toEqual(t.hub.model);
    const history = await t.human.call<{ events: Array<{ type: string }> }>('board_history', { projectId: tm.projectId, id: taskId });
    expect(history.events.map((e) => e.type)).toEqual(expect.arrayContaining(['task.created', 'task.claimed', 'change_request.opened', 'task.status_changed']));
  });

  it('does not merge on an approval of an older head: new commits need review and test again', async () => {
    const tm = await team();
    const { taskId, branch } = await readyAndClaimed(tm);
    tm.wtA.branch(branch);
    const first = tm.wtA.commit('greeting.txt', 'hello there\n', 'v1');
    const cr = await tm.a.client.call<{ id: string }>('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId, branch }, reason: 'v1' });
    const review = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'review', ref: cr.id });
    const test = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'test', ref: cr.id });
    await tm.b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'approved', headSha: first, notes: '' } });
    expect(await taskStatus(tm, taskId)).toBe('in_test');

    // The author pushes more after the approval; the tester still answers for the old commit.
    const second = tm.wtA.commit('greeting.txt', 'hello there, friend\n', 'v2');
    const stale = await rejects(tm.b.client.call('respond', { requestId: test.requestId, result: { kind: 'test', status: 'pass', headSha: first, evidence: 'ok' } }));
    expect(stale.rejection).toBe('stale_head');
    expect(await taskStatus(tm, taskId)).toBe('in_review');
    await t.hub.merges.idle();
    expect(repo.fileOnMain('greeting.txt')).toBe('hello');

    await tm.b.client.call('respond', { requestId: test.requestId, result: { kind: 'test', status: 'pass', headSha: second, evidence: 'ok' } });
    const again = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'review', ref: cr.id });
    await tm.b.client.call('respond', { requestId: again.requestId, result: { kind: 'review', verdict: 'approved', headSha: second, notes: '' } });
    await t.hub.merges.idle();
    expect(await taskStatus(tm, taskId)).toBe('done');
    expect(repo.fileOnMain('greeting.txt')).toBe('hello there, friend');
  });

  it('keeps main untouched when the hub\'s own test run fails, whatever the tester said', async () => {
    const tm = await team();
    const { taskId, branch } = await readyAndClaimed(tm);
    tm.wtA.branch(branch);
    const head = tm.wtA.commit('greeting.txt', 'hello there, broken\n', 'looks fine to me');
    const cr = await tm.a.client.call<{ id: string }>('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId, branch }, reason: 'done' });
    const review = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'review', ref: cr.id });
    const test = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'test', ref: cr.id });
    await tm.b.client.call('respond', { requestId: test.requestId, result: { kind: 'test', status: 'pass', headSha: head, evidence: 'trust me' } });
    await tm.b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'approved', headSha: head, notes: '' } });
    const mainBefore = repo.main();
    await t.hub.merges.idle();
    expect(repo.main()).toBe(mainBefore);
    expect(await taskStatus(tm, taskId)).toBe('in_progress');
    const runs = await t.human.call<{ records: Array<{ status: string }> }>('board_read', { projectId: tm.projectId, section: 'quality' });
    expect(runs.records).toEqual([expect.objectContaining({ status: 'fail' })]);
    expect((await inbox(tm.a)).some((m) => m.body.includes("hub's test run") && m.body.includes('failed'))).toBe(true);
  });

  it('asks the author to rebase when the change conflicts with main', async () => {
    const tm = await team();
    const { taskId, branch } = await readyAndClaimed(tm);
    tm.wtA.branch(branch);
    const head = tm.wtA.commit('greeting.txt', 'hello there\n', 'mine');
    repo.commitOnMain('greeting.txt', 'hello, world\n', 'someone else');
    const cr = await tm.a.client.call<{ id: string }>('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId, branch }, reason: 'done' });
    const review = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'review', ref: cr.id });
    const test = await tm.a.client.call<{ requestId: string }>('request', { to: tm.b.identity.agentId, kind: 'test', ref: cr.id });
    await tm.b.client.call('respond', { requestId: review.requestId, result: { kind: 'review', verdict: 'approved', headSha: head, notes: '' } });
    await tm.b.client.call('respond', { requestId: test.requestId, result: { kind: 'test', status: 'pass', headSha: head, evidence: 'ok' } });
    await t.hub.merges.idle();
    const got = await t.human.call<{ record: { status: string; hubRuns: Array<{ status: string }> } }>('board_get', { projectId: tm.projectId, id: cr.id });
    expect(got.record.status).toBe('rebase_needed');
    expect(got.record.hubRuns).toEqual([expect.objectContaining({ status: 'conflict' })]);
    expect(await taskStatus(tm, taskId)).toBe('in_progress');
    expect((await inbox(tm.a)).find((m) => m.body.includes('conflicts with main'))?.body).toContain('greeting.txt');
  });
});

describe('S2: the board write path', () => {
  it('sends stale proposals back (D5)', async () => {
    const tm = await team();
    const first = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'knowledge', op: 'add', data: { title: 'Tests', body: 'run sh test.sh' }, reason: 'useful' });
    const { committed: entryId } = await tm.lead.client.call<{ committed: string }>('board_commit', { ticketId: first.ticketId });
    const read = await tm.a.client.call<{ boardVersion: number }>('board_read', { section: 'knowledge' });

    const bUpdate = await tm.b.client.call<{ ticketId: string }>('board_propose', { section: 'knowledge', op: 'update', targetId: entryId, baseSeq: read.boardVersion, data: { title: 'Tests', body: 'run sh test.sh from the repo root' }, reason: 'clearer' });
    const aUpdate = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'knowledge', op: 'update', targetId: entryId, baseSeq: read.boardVersion, data: { title: 'Tests', body: 'sh test.sh (fast)' }, reason: 'shorter' });
    await tm.lead.client.call('board_commit', { ticketId: bUpdate.ticketId });
    expect((await rejects(tm.lead.client.call('board_commit', { ticketId: aUpdate.ticketId }))).rejection).toBe('stale_base');
    expect((await inbox(tm.a)).some((m) => m.body.includes('is stale'))).toBe(true);
    const entry = await tm.a.client.call<{ record: { version: number; data: { body: string } } }>('board_get', { id: entryId });
    expect(entry.record).toMatchObject({ version: 2, data: { body: 'run sh test.sh from the repo root' } });
  });

  it('lets only the human set the goal, unless the leader quotes a verified human message', async () => {
    const tm = await team();
    const goal = { objective: 'Greeting in French', constraints: [], successCriteria: [] };
    const unquoted = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'goal', op: 'update', baseSeq: 0, data: goal, reason: 'I think so' });
    expect((await rejects(tm.lead.client.call('board_commit', { ticketId: unquoted.ticketId }))).rejection).toBe('needs_human_quote');

    const { messageId } = await t.human.call<{ messageId: string }>('human.post', { projectId: tm.projectId, to: 'all', body: 'Make it French.' });
    const read = await tm.a.client.call<{ boardVersion: number }>('board_read', { section: 'goal' });
    const quoted = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'goal', op: 'update', baseSeq: read.boardVersion, data: goal, reason: 'human asked', quotesHumanMessage: messageId });
    await inbox(tm.b);
    await tm.lead.client.call('board_commit', { ticketId: quoted.ticketId });
    const view = await tm.b.client.call<{ goal: { version: number; data: { objective: string } } }>('board_view', { view: 'me' });
    expect(view.goal).toMatchObject({ version: 2, data: { objective: 'Greeting in French' } });
    expect((await inbox(tm.b)).find((m) => m.priority === 'critical')?.body).toContain('goal updated');

    const rules = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'rules', op: 'update', baseSeq: 99, data: { testCommand: 'true' }, reason: 'faster' });
    expect((await rejects(tm.lead.client.call('board_commit', { ticketId: rules.ticketId }))).rejection).toBe('needs_vote');
  });

  it('refuses direct board writes from workers and hub-only sections from proposals', async () => {
    const tm = await team();
    const ticket = await tm.a.client.call<{ ticketId: string }>('board_propose', { section: 'decisions', op: 'add', data: { what: 'x', why: 'y' }, reason: 'r' });
    expect((await rejects(tm.a.client.call('board_commit', { ticketId: ticket.ticketId }))).code).toBe('forbidden');
    expect((await rejects(tm.a.client.call('board_propose', { section: 'roster', op: 'add', data: {}, reason: 'r' }))).rejection).toBe('not_proposable');
    expect((await rejects(tm.a.client.call('board_propose', { section: 'decisions', op: 'add', data: { what: 'x' }, reason: 'r' }))).rejection).toBe('invalid_data');
    expect((await rejects(tm.a.client.call('board_propose', { section: 'artifacts', op: 'open', data: { kind: 'change_request', taskId: 'tsk_00000000000000000000000099', branch: 'nope' }, reason: 'r' }))).rejection).toBe('unknown_task');
  });

  it('warns when the main branch is checked out, and refuses paths that are not repositories', async () => {
    t = await TestHub.start();
    repo = new SampleRepo();
    const lead = await t.pair('Lead', { newProjectName: 'P' });
    const projectId = lead.session.projectId;
    expect((await rejects(t.human.call('repo.attach', { projectId, path: repo.root, mainBranch: 'main' }))).code).toBe('invalid_input');
    const wt = repo.worktree();
    const out = await t.human.call<{ repoId: string; warning?: string }>('repo.attach', { projectId, path: wt.dir, mainBranch: 'main' });
    expect(out.warning).toBeUndefined();
    await import('../src/index.ts').then(({ git }) => git(repo.path, 'switch', '-q', 'main'));
    const again = await t.human.call<{ repoId: string; warning?: string }>('repo.attach', { projectId, path: repo.path, mainBranch: 'main' });
    expect(again.repoId).toBe(out.repoId);
    expect(again.warning).toContain('checked out');
  });
});
