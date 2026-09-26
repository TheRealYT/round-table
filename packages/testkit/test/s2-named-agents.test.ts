import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '@round-table/agent';
import { McpAgent, TestHub } from '../src/index.ts';

let t: TestHub;
const agents: McpAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await t?.close();
});

async function start(keyStore: MemoryKeyStore) {
  const a = await McpAgent.start(t, { slot: null, keyStore, tools: 'static', briefing: false });
  agents.push(a);
  return a;
}

/** The human side of pairing: allow the request with this phrase and return the code. */
async function allow(text: string, target: { projectId: string } | { newProjectName: string }) {
  const phrase = /match phrase: (\S+)/.exec(text)?.[1];
  const { requests } = await t.human.call<{ requests: Array<{ requestId: string; matchPhrase: string }> }>('pairing.list');
  const request = requests.find((r) => r.matchPhrase === phrase);
  if (!request) throw new Error(`no request for phrase ${phrase}: ${text}`);
  return t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: request.requestId, ...target });
}

type Row = { agentId: string; name: string; connected: boolean };
const roster = (projectId: string) => t.human.call<{ records: Row[] }>('board_read', { section: 'roster', projectId }).then((r) => r.records);

describe('identity by join name, not by config (ADR-0016)', () => {
  it('two chats started from the same IDE config are two agents, both online', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore(); // same machine, same config: shared key store
    const chat1 = await start(keyStore);
    const chat2 = await start(keyStore);
    const { code, projectId } = await allow(await chat1.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    await chat1.call('join_confirm', { code });
    const second = await allow(await chat2.call('join_request', { name: 'Bo' }), { projectId });
    await chat2.call('join_confirm', { code: second.code });

    const rows = await roster(projectId);
    expect(rows.map((r) => [r.name, r.connected]).sort()).toEqual([['Ada', true], ['Bo', true]]);
    expect(await chat1.call('activity', { doing: 'still me', next: 'x' })).not.toMatch(/^ERROR/);
  });

  it('a new chat that joins with a known name is that agent again, without a code', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const first = await start(keyStore);
    const { code, projectId } = await allow(await first.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    await first.call('join_confirm', { code });
    const before = (await roster(projectId))[0]!.agentId;

    const later = await start(keyStore);
    const back = await later.call('join_request', { name: 'Ada' });
    expect(back).toContain('Welcome back');
    expect(back).not.toContain('match phrase');
    const rows = await roster(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(before);
  });

  it('one server shared by several chats carries several agents; calls say who they are with `as`', async () => {
    t = await TestHub.start();
    const server = await start(new MemoryKeyStore());
    const ada = await allow(await server.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    const bo = await allow(await server.call('join_request', { name: 'Bo' }), { projectId: ada.projectId });
    await server.call('join_confirm', { code: ada.code, as: 'Ada' });
    await server.call('join_confirm', { code: bo.code, as: 'Bo' });
    expect((await roster(ada.projectId)).filter((r) => r.connected)).toHaveLength(2);

    expect(await server.call('wait', { timeoutMs: 10 })).toContain('several agents use this server (ada, bo): pass as');
    const [adaId] = (await roster(ada.projectId)).filter((r) => r.name === 'Ada').map((r) => r.agentId);
    await server.call('send', { to: [adaId], type: 'chat', body: 'hi Ada, from Bo', as: 'Bo' });
    expect(await server.call('wait', { timeoutMs: 10, as: 'Ada' })).toContain('hi Ada, from Bo');
    expect(await server.call('wait', { timeoutMs: 10, as: 'Bo' })).not.toContain('hi Ada, from Bo');
    expect(await server.call('wait', { as: 'Cy' })).toContain('no agent named "Cy"');
  });

  it('finishes pairing when the chat’s server restarted between join_request and the code', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const before = await start(keyStore);
    const { code } = await allow(await before.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    await before.close();
    agents.splice(agents.indexOf(before), 1);
    const after = await start(keyStore);
    expect(await after.call('join_confirm', { code })).toContain('Paired.');
  });
});

describe('a chat stopped by the human (the client cancels the tool call)', () => {
  it('shows the agent as stopped, and the message that arrived meanwhile comes again on the next wait', async () => {
    t = await TestHub.start();
    const server = await start(new MemoryKeyStore());
    const { code, projectId } = await allow(await server.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    await server.call('join_confirm', { code });
    type Seen = { name: string; attention: { waiting: boolean; stopped: boolean } | null };
    const ada = async () => (await t.human.call<{ records: Seen[] }>('board_read', { section: 'roster', projectId })).records[0]!.attention;
    expect(await ada()).toMatchObject({ waiting: false, stopped: false });

    const stop = new AbortController();
    const pending = server.client.callTool({ name: 'wait', arguments: { timeoutMs: 5_000 } }, undefined, { signal: stop.signal });
    await expect.poll(ada).toMatchObject({ waiting: true });
    stop.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(ada).toMatchObject({ stopped: true });

    // The hub's wait was still open, so this reaches the cancelled call, which nobody reads.
    await t.human.call('human.post', { projectId, to: 'all', body: 'are you there?' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ada()).toMatchObject({ stopped: true });

    // The human types "continue": the next wait gets the message and the agent is running again.
    expect(await server.call('wait', { timeoutMs: 10 })).toContain('are you there?');
    expect(await ada()).toMatchObject({ stopped: false });
  });
});
