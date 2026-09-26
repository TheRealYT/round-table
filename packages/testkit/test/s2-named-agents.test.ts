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

type Request = { requestId: string; matchPhrase: string; resumes: string | null };

/** The human side of pairing: allow the request with this phrase and return the code. */
async function allow(text: string, target: { projectId: string } | { newProjectName: string } | Record<string, never>) {
  const phrase = /match phrase: (\S+)/.exec(text)?.[1];
  const { requests } = await t.human.call<{ requests: Request[] }>('pairing.list');
  const request = requests.find((r) => r.matchPhrase === phrase);
  if (!request) throw new Error(`no request for phrase ${phrase}: ${text}`);
  return t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: request.requestId, ...target });
}

/** The chat token from a join_confirm result. */
function tokenOf(text: string): string {
  const token = /chat token is "([^"]+)"/.exec(text)?.[1];
  if (!token) throw new Error(`no chat token in: ${text}`);
  return token;
}

/** A chat pairs a new name and gets its token. */
async function pairNew(chat: McpAgent, name: string, target: { projectId: string } | { newProjectName: string }) {
  const { code, projectId } = await allow(await chat.call('join_request', { name }), target);
  return { token: tokenOf(await chat.call('join_confirm', { code, name })), projectId };
}

type Row = { agentId: string; name: string; connected: boolean };
const roster = (projectId: string) => t.human.call<{ records: Row[] }>('board_read', { section: 'roster', projectId }).then((r) => r.records);

describe('identity by join name, not by config (ADR-0016)', () => {
  it('two chats started from the same IDE config are two agents, both connected', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore(); // same machine, same config: shared key store
    const chat1 = await start(keyStore);
    const chat2 = await start(keyStore);
    const ada = await pairNew(chat1, 'Ada', { newProjectName: 'P' });
    await pairNew(chat2, 'Bo', { projectId: ada.projectId });

    const rows = await roster(ada.projectId);
    expect(rows.map((r) => [r.name, r.connected]).sort()).toEqual([['Ada', true], ['Bo', true]]);
    expect(await chat1.call('activity', { doing: 'still me', next: 'x', token: ada.token })).toContain('you are ada');
  });

  it('one server shared by several chats carries several agents; each call says who it is with its token', async () => {
    t = await TestHub.start();
    const server = await start(new MemoryKeyStore());
    const ada = await pairNew(server, 'Ada', { newProjectName: 'P' });
    const bo = await pairNew(server, 'Bo', { projectId: ada.projectId });
    expect((await roster(ada.projectId)).filter((r) => r.connected)).toHaveLength(2);

    expect(await server.call('wait', { timeoutMs: 10 })).toContain('this call needs token');
    const [adaId] = (await roster(ada.projectId)).filter((r) => r.name === 'Ada').map((r) => r.agentId);
    await server.call('send', { to: [adaId], type: 'chat', body: 'hi Ada, from Bo', token: bo.token });
    expect(await server.call('wait', { timeoutMs: 10, token: ada.token })).toContain('hi Ada, from Bo');
    expect(await server.call('wait', { timeoutMs: 10, token: bo.token })).not.toContain('hi Ada, from Bo');
  });

  it('finishes pairing when the chat’s server restarted between join_request and the code', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const before = await start(keyStore);
    const { code } = await allow(await before.call('join_request', { name: 'Ada' }), { newProjectName: 'P' });
    await before.close();
    agents.splice(agents.indexOf(before), 1);
    const after = await start(keyStore);
    const out = await after.call('join_confirm', { code });
    expect(out).toContain('Paired.');
    expect(await after.call('activity', { doing: 'x', next: 'y', token: tokenOf(out) })).not.toContain('failed');
  });
});

describe('a name is not a password (ADR-0017)', () => {
  it('a new chat that says a paired name gets nothing until the human approves it, then takes over', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const first = await start(keyStore);
    const ada = await pairNew(first, 'Ada', { newProjectName: 'P' });
    const [before] = await roster(ada.projectId);

    // A second chat on the same server claims to be Ada.
    const intruder = await start(keyStore);
    for (const token of [undefined, 'ada', 'ada.guessed123', ada.token.replace(/.$/, 'x')]) {
      const out = await intruder.call('wait', { timeoutMs: 10, ...(token && { token }) });
      expect(out).toMatch(/failed/);
      expect(out).not.toContain('next:');
    }
    const asked = await intruder.call('join_request', { name: 'Ada' });
    expect(asked).toContain('already paired');
    expect(asked).toContain('match phrase');
    expect(asked).not.toContain('Welcome back');
    expect(await intruder.call('activity', { doing: 'x', next: 'y' })).toMatch(/failed/);

    // The human sees it is about the existing Ada, not a new agent.
    const { requests } = await t.human.call<{ requests: Request[] }>('pairing.list');
    expect(requests).toEqual([expect.objectContaining({ resumes: before!.agentId })]);

    // The human denies it: still nothing.
    await t.human.call('pairing.deny', { requestId: requests[0]!.requestId });
    expect(await intruder.call('join_confirm', { code: 'ABCDEFGH', name: 'Ada' })).toMatch(/failed/);
    expect(await first.call('activity', { doing: 'still me', next: 'x', token: ada.token })).not.toMatch(/failed/);

    // The human approves a later request: the new chat is Ada (same agent), the old chat is out.
    const { code } = await allow(await intruder.call('join_request', { name: 'Ada' }), {});
    const newToken = tokenOf(await intruder.call('join_confirm', { code, name: 'Ada' }));
    expect(newToken).not.toBe(ada.token);
    const rows = await roster(ada.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(before!.agentId);
    expect(await intruder.call('activity', { doing: 'me now', next: 'x', token: newToken })).not.toMatch(/failed/);
    const old = await first.call('activity', { doing: 'x', next: 'y', token: ada.token });
    expect(old).toContain('another chat now works as this agent');
  });

  it('a chat that keeps its token carries on after the server restarts, with no human step', async () => {
    t = await TestHub.start();
    const keyStore = new MemoryKeyStore();
    const before = await start(keyStore);
    const ada = await pairNew(before, 'Ada', { newProjectName: 'P' });
    await before.close();
    agents.splice(agents.indexOf(before), 1);

    const after = await start(keyStore);
    expect(await after.call('activity', { doing: 'back', next: 'x', token: ada.token })).not.toMatch(/failed/);
    expect((await roster(ada.projectId))[0]!.connected).toBe(true);
  });

  it('on one shared server too: the old chat’s wait in flight gets "stop", and its messages go to the new chat', async () => {
    t = await TestHub.start();
    const server = await start(new MemoryKeyStore());
    const ada = await pairNew(server, 'Ada', { newProjectName: 'P' });
    const oldWait = server.call('wait', { timeoutMs: 2_000, token: ada.token });

    const newChat = server; // a second chat of the same IDE: same server, no token
    const { code } = await allow(await newChat.call('join_request', { name: 'Ada' }), {});
    const newToken = tokenOf(await newChat.call('join_confirm', { code, name: 'Ada' }));
    await t.human.call('human.post', { projectId: ada.projectId, to: 'all', body: 'for whoever is Ada now' });

    expect(await oldWait).toContain('another chat now works as this agent');
    expect(await newChat.call('wait', { timeoutMs: 10, token: newToken })).toContain('for whoever is Ada now');
  });
});

describe('a chat stopped by the human (the client cancels the tool call)', () => {
  it('shows the agent as stopped, and the message that arrived meanwhile comes again on the next wait', async () => {
    t = await TestHub.start();
    const server = await start(new MemoryKeyStore());
    const { token, projectId } = await pairNew(server, 'Ada', { newProjectName: 'P' });
    type Seen = { name: string; attention: { waiting: boolean; stopped: boolean } | null };
    const ada = async () => (await t.human.call<{ records: Seen[] }>('board_read', { section: 'roster', projectId })).records[0]!.attention;
    expect(await ada()).toMatchObject({ waiting: false, stopped: false });

    const stop = new AbortController();
    const pending = server.client.callTool({ name: 'wait', arguments: { timeoutMs: 5_000, token } }, undefined, { signal: stop.signal });
    await expect.poll(ada).toMatchObject({ waiting: true });
    stop.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(ada).toMatchObject({ stopped: true });

    // The hub's wait was still open, so this reaches the cancelled call, which nobody reads.
    await t.human.call('human.post', { projectId, to: 'all', body: 'are you there?' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ada()).toMatchObject({ stopped: true });

    // The human types "continue": the next wait gets the message and the agent is running again.
    expect(await server.call('wait', { timeoutMs: 10, token })).toContain('are you there?');
    expect(await ada()).toMatchObject({ stopped: false });
  });
});
