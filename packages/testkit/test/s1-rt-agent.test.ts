import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '@round-table/agent';
import { McpAgent, settle, TestHub } from '../src/index.ts';

let t: TestHub;
const agents: McpAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await t?.close();
});

async function start(options: Parameters<typeof McpAgent.start>[1] = {}) {
  const a = await McpAgent.start(t, options);
  agents.push(a);
  return a;
}

/** Pairs an McpAgent the way a human and a model would: phrase shown, human allows, code pasted in chat. */
async function pairViaMcp(agent: McpAgent, name: string, target: { projectId: string } | { newProjectName: string }) {
  const requested = await agent.call('join_request', { name });
  const phrase = /match phrase: (\S+)/.exec(requested)?.[1];
  const list = await t.human.call<{ requests: Array<{ requestId: string; matchPhrase: string }> }>('pairing.list');
  const request = list.requests.find((r) => r.matchPhrase === phrase);
  if (!request) throw new Error(`no request with phrase ${phrase}`);
  const { code, projectId } = await t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: request.requestId, ...target });
  const confirmed = await agent.call('join_confirm', { code });
  return { confirmed, projectId };
}

describe('S1 rt-agent over MCP', () => {
  it('explains the [Round Table] status line in its server instructions (S0 finding 6)', async () => {
    t = await TestHub.start();
    const a = await start();
    expect(await a.instructions()).toContain('"[Round Table]"');
  });

  it('shows only pairing tools until paired, then the worker tools, without the model ever seeing keys', async () => {
    t = await TestHub.start();
    const a = await start();
    expect(await a.tools()).toEqual(['join_confirm', 'join_request']);
    const schema = (await a.client.listTools()).tools.find((tool) => tool.name === 'join_request')?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).not.toContain('publicKey');

    const before = a.listChanged;
    const { confirmed, projectId } = await pairViaMcp(a, 'Worker A', { newProjectName: 'Demo' });
    expect(confirmed).toContain(`worker in project ${projectId}`);
    await settle();
    expect(a.listChanged).toBeGreaterThan(before);
    const tools = await a.tools();
    expect(tools).toEqual(expect.arrayContaining(['send', 'wait', 'activity', 'claim', 'board_read']));
    expect(tools).not.toContain('join_request');
    expect(tools).not.toContain('board_commit');
  });

  it('exchanges messages between two agents and hands human messages over inline on any tool call', async () => {
    t = await TestHub.start();
    const a = await start({ slot: 'a' });
    const b = await start({ slot: 'b' });
    const { projectId } = await pairViaMcp(a, 'A', { newProjectName: 'P' });
    await pairViaMcp(b, 'B', { projectId });

    await a.call('send', { to: 'all', type: 'chat', body: 'hello from A' });
    expect(await b.call('wait')).toMatch(/\[normal\] chat from agt_\w+ \(worker\).*: hello from A/);

    await t.human.call('human.post', { projectId, to: 'all', body: 'Stop editing api.ts' });
    await settle();
    // B is busy (not waiting): the human's message arrives with its next Round Table call.
    const busy = await b.call('activity', { doing: 'editing api.ts', next: 'tests' });
    expect(busy).toContain('[Round Table] messages for you:');
    expect(busy).toContain('[human] human from human');
    expect(busy).toContain('Stop editing api.ts');
    // Handed over once: the next wait acks it and does not repeat it.
    expect(await b.call('wait', { timeoutMs: 10 })).toMatch(/^No new messages\.\n\n\[Round Table\] next: /);
  });

  it('reports lower-priority mail as a factual count, and nothing when the inbox is empty', async () => {
    t = await TestHub.start();
    const a = await start({ slot: 'a' });
    const b = await start({ slot: 'b' });
    const { projectId } = await pairViaMcp(a, 'A', { newProjectName: 'P' });
    await pairViaMcp(b, 'B', { projectId });
    expect(await b.call('activity', { doing: 'x', next: 'y' })).not.toContain('[Round Table] inbox');
    await a.call('send', { to: 'all', type: 'chat', body: 'fyi' });
    await settle();
    expect(await b.call('activity', { doing: 'x', next: 'y' })).toContain('[Round Table] inbox: 1 message waiting (1 normal). Read with wait.');
  });

  it('rejoins automatically on restart with the stored key; the model does nothing', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const first = await start({ slot: 'a', keyStore });
    const { projectId } = await pairViaMcp(first, 'A', { newProjectName: 'P' });
    await first.close();
    agents.splice(agents.indexOf(first), 1);

    const restarted = await start({ slot: 'a', keyStore });
    expect(await restarted.tools()).toContain('wait');
    await t.human.call('human.post', { projectId, to: 'all', body: 'welcome back' });
    expect(await restarted.call('wait')).toContain('welcome back');
  });

  it('finishes pairing after an rt-agent restart between join_request and the code', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const first = await start({ slot: 'a', keyStore });
    const requested = await first.call('join_request', { name: 'A' });
    const phrase = /match phrase: (\S+)/.exec(requested)?.[1];
    await first.close();
    agents.splice(agents.indexOf(first), 1);
    const list = await t.human.call<{ requests: Array<{ requestId: string; matchPhrase: string }> }>('pairing.list');
    const request = list.requests.find((r) => r.matchPhrase === phrase)!;
    const { code, projectId } = await t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: request.requestId, newProjectName: 'P' });

    const restarted = await start({ slot: 'a', keyStore });
    expect(await restarted.call('join_confirm', { code })).toContain(`worker in project ${projectId}`);
  });

  it('shows leader tools when the human assigns the leader role', async () => {
    t = await TestHub.start();
    const a = await start();
    const { projectId } = await pairViaMcp(a, 'Lead', { newProjectName: 'P' });
    const roster = await t.human.call<{ records: Array<{ agentId: string }> }>('board_read', { section: 'roster', projectId });
    const before = a.listChanged;
    await t.human.call('leader.assign', { projectId, agentId: roster.records[0]!.agentId });
    await settle();
    expect(a.listChanged).toBeGreaterThan(before);
    const tools = await a.tools();
    expect(tools).toEqual(expect.arrayContaining(['board_commit', 'broadcast_critical', 'open_vote']));
    expect(tools).not.toContain('claim');
  });

  it('stops serving after being fenced by a newer session with the same identity', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const old = await start({ slot: 'a', keyStore });
    await pairViaMcp(old, 'A', { newProjectName: 'P' });
    await start({ slot: 'a', keyStore });
    await settle();
    expect(old.bridge.currentRole).toBe('fenced');
    expect(await old.tools()).toEqual([]);
  });

  it('reconnects and rejoins after the hub connection drops', async () => {
    t = await TestHub.start();
    const a = await start();
    const { projectId } = await pairViaMcp(a, 'A', { newProjectName: 'P' });
    await t.network.close(); // drops every connection, like a hub restart
    await new Promise((r) => setTimeout(r, 100));
    await t.human.call('human.post', { projectId, to: 'all', body: 'still there?' }).catch(() => undefined);
    t.human = await t.connectHuman();
    await t.human.call('human.post', { projectId, to: 'all', body: 'still there?' });
    expect(await a.call('wait')).toContain('still there?');
  });

  it('works for clients without list_changed or instructions: static tools, hub-enforced roles, briefing once (ADR-0014)', async () => {
    t = await TestHub.start();
    const a = await start({ tools: 'static', briefing: true });
    const all = await a.tools();
    expect(all).toEqual(expect.arrayContaining(['join_request', 'wait', 'claim', 'board_commit']));
    const desc = (await a.client.listTools()).tools;
    expect(desc.find((x) => x.name === 'board_commit')?.description).toMatch(/^Leader only\./);
    expect(desc.find((x) => x.name === 'wait')?.description).toContain('[Round Table]');

    expect(await a.call('wait')).toContain('not joined yet: call join_request with your name first');
    const { projectId } = await pairViaMcp(a, 'Codex A', { newProjectName: 'P' });
    expect(await a.tools()).toEqual(all); // nothing changes; no list_changed needed
    expect(await a.call('board_commit', { ticketId: 'tkt_00000000000000000000000001' })).toMatch(/^ERROR .*forbidden: worker may not call board_commit/);

    // The briefing rides on the first successful call of a session (here join_request), once.
    await t.human.call('human.post', { projectId, to: 'all', body: 'hi' });
    expect(await a.call('wait')).not.toContain('briefing');
    const b = await start({ slot: 'b', tools: 'static', briefing: true });
    expect(await b.call('join_request', { name: 'Gemini B' })).toContain('[Round Table] briefing');
  });
});
