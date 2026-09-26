import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, HubClient, HubError, requestJoin, confirmJoin } from '@round-table/agent';
import { evolve, initialModel } from '@round-table/core';
import { generateIdentityKey, signMessage, challengeResponseMessage } from '@round-table/protocol/crypto';
import { settle, TestHub } from '../src/index.ts';

const MIN = 60_000;
let t: TestHub;
afterEach(async () => t?.close());

async function rejects(p: Promise<unknown>): Promise<HubError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof HubError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

type RosterRecord = { agentId: string; state: string; connected: boolean; role: string };
async function roster(t: TestHub, projectId: string): Promise<RosterRecord[]> {
  const out = await t.human.call<{ records: RosterRecord[] }>('board_read', { section: 'roster', projectId });
  return out.records;
}

describe('S1 pairing', () => {
  it('pairs an agent: match phrase, human allows into a new project, code, signed confirm, key-signed session', async () => {
    t = await TestHub.start();
    const agent = await t.connectAgent();
    const pending = await requestJoin(agent, { name: 'Worker A', client: 'test', tags: ['backend'] });
    expect(pending.request.matchPhrase).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);

    const list = await t.human.call<{ requests: Array<{ requestId: string; matchPhrase: string; fingerprint: string; codeHash?: string }> }>('pairing.list');
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ requestId: pending.request.requestId, matchPhrase: pending.request.matchPhrase });
    expect(list.requests[0]).not.toHaveProperty('codeHash');

    const allowed = await t.human.call<{ code: string; projectId: string }>('pairing.allow', { requestId: pending.request.requestId, newProjectName: 'Demo' });
    expect(allowed.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    const identity = await confirmJoin(agent, pending, allowed.code.toLowerCase(), t.clock.now());
    const session = await authenticate(agent, identity);
    expect(session).toMatchObject({ epoch: 1, projectId: allowed.projectId, role: 'worker' });

    expect(await roster(t, allowed.projectId)).toEqual([expect.objectContaining({ agentId: identity.agentId, state: 'active', connected: true, role: 'worker' })]);
    // The code never reaches the log, only its hash, and only until it is used.
    const log = JSON.stringify([...t.hub.store.all()]);
    expect(log).not.toContain(allowed.code);
  });

  it('voids the request after 3 wrong codes', async () => {
    t = await TestHub.start();
    const agent = await t.connectAgent();
    const pending = await requestJoin(agent, { name: 'A', client: 'test' });
    await t.human.call('pairing.allow', { requestId: pending.request.requestId, newProjectName: 'P' });
    expect((await rejects(confirmJoin(agent, pending, 'AAAAAAAA', 0))).rejection).toBe('wrong_code');
    expect((await rejects(confirmJoin(agent, pending, 'AAAAAAAA', 0))).rejection).toBe('wrong_code');
    expect((await rejects(confirmJoin(agent, pending, 'AAAAAAAA', 0))).rejection).toBe('voided');
    expect((await rejects(confirmJoin(agent, pending, 'AAAAAAAA', 0))).rejection).toBe('not_allowed');
  });

  it('rejects a correct code signed by a different key', async () => {
    t = await TestHub.start();
    const agent = await t.connectAgent();
    const pending = await requestJoin(agent, { name: 'A', client: 'test' });
    const { code } = await t.human.call<{ code: string }>('pairing.allow', { requestId: pending.request.requestId, newProjectName: 'P' });
    const thief = { ...pending, key: generateIdentityKey() };
    expect((await rejects(confirmJoin(agent, thief, code, 0))).rejection).toBe('wrong_code');
  });

  it('expires the code after 5 minutes and unanswered requests after 10', async () => {
    t = await TestHub.start();
    const agent = await t.connectAgent();
    const a = await requestJoin(agent, { name: 'A', client: 'test' });
    const b = await requestJoin(agent, { name: 'B', client: 'test' });
    const { code } = await t.human.call<{ code: string }>('pairing.allow', { requestId: a.request.requestId, newProjectName: 'P' });
    t.advance(5 * MIN);
    expect((await rejects(confirmJoin(agent, a, code, 0))).rejection).toBe('not_allowed');
    t.advance(5 * MIN);
    const list = await t.human.call<{ requests: unknown[] }>('pairing.list');
    expect(list.requests).toEqual([]);
    expect((await rejects(t.human.call('pairing.allow', { requestId: b.request.requestId, newProjectName: 'P' }))).rejection).toBe('not_pending');
  });

  it('blocks an origin and rate-limits pending requests per origin', async () => {
    t = await TestHub.start({ settings: { pairingMaxPendingPerOrigin: 2 } });
    const agent = await t.connectAgent();
    await requestJoin(agent, { name: 'A', client: 'test' });
    await requestJoin(agent, { name: 'B', client: 'test' });
    expect((await rejects(requestJoin(agent, { name: 'C', client: 'test' }))).rejection).toBe('rate_limited');
    await t.human.call('pairing.block_origin', { origin: '127.0.0.1' });
    expect((await rejects(requestJoin(agent, { name: 'D', client: 'test' }))).rejection).toBe('origin_blocked');
  });
});

describe('S1 access control', () => {
  it('keeps agents out of human procedures and unpaired connections out of everything but pairing', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    expect((await rejects(a.client.call('pairing.allow', { requestId: 'pair_00000000000000000000000001', newProjectName: 'x' }))).code).toBe('forbidden');
    expect((await rejects(a.client.call('human.post', { projectId: a.session.projectId, to: 'all', body: 'I am the human' }))).code).toBe('forbidden');
    const stranger = await t.connectAgent();
    expect((await rejects(stranger.call('send', { to: 'all', type: 'chat', body: 'hi' }))).code).toBe('forbidden');
    expect((await rejects(stranger.call('board_read', { section: 'roster' }))).code).toBe('forbidden');
  });

  it('refuses app connections without a login cookie', async () => {
    t = await TestHub.start();
    const intruder = new HubClient(await t.network.connect('app'));
    const closed = new Promise<string>((resolve) => intruder.onClose(resolve));
    expect(await closed).toBe('unauthenticated');
  });

  it('refuses a rejoin signed with the wrong key, and replayed challenges', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const imposter = await t.connectAgent();
    expect((await rejects(authenticate(imposter, { ...a.identity, privateKey: generateIdentityKey().privateKey }))).code).toBe('unauthenticated');

    const c = await imposter.call<{ nonce: string; ts: number; hubId: string }>('session.challenge', { agentId: a.identity.agentId });
    const signature = signMessage(a.identity.privateKey, challengeResponseMessage({ hubId: c.hubId, agentId: a.identity.agentId, nonce: c.nonce, ts: c.ts }));
    await imposter.call('session.prove', { agentId: a.identity.agentId, nonce: c.nonce, signature });
    const replay = await t.connectAgent();
    expect((await rejects(replay.call('session.prove', { agentId: a.identity.agentId, nonce: c.nonce, signature }))).code).toBe('unauthenticated');
  });

  it('expires challenges after 30 seconds', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const client = await t.connectAgent();
    const c = await client.call<{ nonce: string; ts: number; hubId: string }>('session.challenge', { agentId: a.identity.agentId });
    t.advance(31_000);
    const signature = signMessage(a.identity.privateKey, challengeResponseMessage({ hubId: c.hubId, agentId: a.identity.agentId, nonce: c.nonce, ts: c.ts }));
    expect((await rejects(client.call('session.prove', { agentId: a.identity.agentId, nonce: c.nonce, signature }))).message).toContain('expired');
  });

  it('lets only the leader send critical, and assigning a leader updates the live session', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const b = await t.pair('B', { projectId: a.session.projectId });
    expect((await rejects(a.client.call('send', { to: 'all', type: 'alert', body: 'x', priority: 'critical' }))).rejection).toBe('forbidden_priority');
    const role = new Promise((resolve) => a.client.on('role', resolve));
    await t.human.call('leader.assign', { projectId: a.session.projectId, agentId: a.identity.agentId });
    expect(await role).toEqual({ role: 'leader' });
    await a.client.call('send', { to: 'all', type: 'alert', body: 'main is broken', priority: 'critical' });
    const got = await b.client.call<{ items: Array<{ priority: string; body: string }> }>('wait', { ack: [] });
    expect(got.items).toEqual([expect.objectContaining({ priority: 'critical', body: 'main is broken' })]);
  });
});

describe('S1 messaging and wait', () => {
  it('delivers direct messages, human first, with acks and inbox pushes', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const b = await t.pair('B', { projectId: a.session.projectId });
    const counts: unknown[] = [];
    b.client.on('inbox', (c) => counts.push(c));

    await a.client.call('send', { to: [b.identity.agentId], type: 'chat', body: 'are you touching api.ts?' });
    await t.human.call('human.post', { projectId: a.session.projectId, to: 'all', body: 'Stop and read the new goal.' });
    await settle();
    expect(counts.at(-1)).toMatchObject({ human: 1, direct: 1 });

    type Item = { deliveryId: number; from: string; role: string; priority: string; body: string };
    const first = await b.client.call<{ items: Item[]; more: number }>('wait', { ack: [] });
    expect(first.items.map((i) => [i.role, i.priority])).toEqual([['human', 'human'], ['worker', 'direct']]);
    expect(first.items[1]?.from).toBe(a.identity.agentId);

    // Unacked items come back (at-least-once) until rt-agent acks them on the next call.
    const again = await b.client.call<{ items: Item[] }>('wait', { ack: [], timeoutMs: 10 });
    expect(again.items).toHaveLength(2);
    const after = await b.client.call<{ items: Item[] }>('wait', { ack: first.items.map((i) => i.deliveryId), timeoutMs: 10 });
    expect(after.items).toEqual([]);
    await settle();
    expect(counts.at(-1)).toMatchObject({ human: 0, direct: 0 });

    // The sender never receives its own message; the human's reached A too.
    const own = await a.client.call<{ items: Item[] }>('wait', { ack: [], timeoutMs: 10 });
    expect(own.items.map((i) => i.body)).toEqual(['Stop and read the new goal.']);
  });

  it('wakes a blocked wait as soon as a human message arrives, without the coalescing delay', async () => {
    t = await TestHub.start({ config: { waitMaxMs: 10_000, coalesceMs: 5_000 } });
    const a = await t.pair('A', { newProjectName: 'P' });
    const started = Date.now();
    const waiting = a.client.call<{ items: Array<{ body: string }> }>('wait', { ack: [] });
    await settle();
    await t.human.call('human.post', { projectId: a.session.projectId, to: [a.identity.agentId], body: 'pause' });
    const got = await waiting;
    expect(got.items.map((i) => i.body)).toEqual(['pause']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('holds normal messages for the coalescing window so a burst arrives together', async () => {
    t = await TestHub.start({ config: { waitMaxMs: 10_000, coalesceMs: 300 } });
    const a = await t.pair('A', { newProjectName: 'P' });
    const b = await t.pair('B', { projectId: a.session.projectId });
    const started = Date.now();
    const waiting = b.client.call<{ items: Array<{ body: string }> }>('wait', { ack: [] });
    await settle();
    await a.client.call('send', { to: 'all', type: 'chat', body: 'one' });
    await a.client.call('send', { to: 'all', type: 'chat', body: 'two' });
    const got = await waiting;
    expect(got.items.map((i) => i.body)).toEqual(['one', 'two']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('verifies "the human said" quotes and rejects unknown recipients', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const { messageId } = await t.human.call<{ messageId: string }>('human.post', { projectId: a.session.projectId, to: 'all', body: 'use postgres' });
    await a.client.call('send', { to: 'all', type: 'proposal', body: 'switching to postgres', quotesHumanMessage: messageId });
    expect((await rejects(a.client.call('send', { to: 'all', type: 'proposal', body: 'x', quotesHumanMessage: 'msg_00000000000000000000000099' }))).rejection).toBe('unverified_quote');
    expect((await rejects(a.client.call('send', { to: ['agt_00000000000000000000000099'], type: 'chat', body: 'x' }))).rejection).toBe('unknown_recipient');
  });

  it('keeps projects isolated', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P1' });
    const b = await t.pair('B', { newProjectName: 'P2' });
    await a.client.call('send', { to: 'all', type: 'chat', body: 'only for P1' });
    const got = await b.client.call<{ items: unknown[] }>('wait', { ack: [], timeoutMs: 10 });
    expect(got.items).toEqual([]);
    expect((await rejects(b.client.call('board_read', { section: 'roster', projectId: a.session.projectId }))).code).toBe('forbidden');
  });
});

describe('S1 liveness, rejoin and fencing', () => {
  it('goes stale 3 min after a disconnect, gone after the 10 min grace, and resumes if back in time', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const projectId = a.session.projectId;
    const stateOf = async () => (await roster(t, projectId))[0];

    a.client.close();
    await settle();
    expect(await stateOf()).toMatchObject({ state: 'active', connected: false });
    t.advance(3 * MIN - 1);
    expect((await stateOf())?.state).toBe('active');
    t.advance(1);
    expect((await stateOf())?.state).toBe('stale');

    const back = await t.rejoin(a.identity);
    expect(back.session).toMatchObject({ epoch: 2, resumed: true });
    expect(await stateOf()).toMatchObject({ state: 'active', connected: true });
    t.advance(60 * MIN); // the cancelled grace timer never fires
    expect((await stateOf())?.state).toBe('active');

    back.client.close();
    await settle();
    t.advance(3 * MIN);
    t.advance(10 * MIN);
    expect((await stateOf())?.state).toBe('gone');
    const late = await t.rejoin(a.identity);
    expect(late.session).toMatchObject({ resumed: false, role: 'worker' });
    expect((await stateOf())?.state).toBe('active');
  });

  it('fences the older session when the same key proves itself again', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const fenced = new Promise((resolve) => a.client.on('fenced', resolve));
    const second = await t.rejoin(a.identity);
    expect(second.session.epoch).toBe(2);
    await fenced;
    await settle();
    expect(a.client.open).toBe(false);
    // The fenced session closing does not mark the live one disconnected.
    expect((await roster(t, a.session.projectId))[0]).toMatchObject({ connected: true });
    await second.client.call('activity', { doing: 'still here', next: 'more' });
  });
});

describe('S1 durability', () => {
  it('rebuilds the same model and deliveries from the log (invariant 2)', async () => {
    t = await TestHub.start();
    const a = await t.pair('A', { newProjectName: 'P' });
    const b = await t.pair('B', { projectId: a.session.projectId });
    await a.client.call('send', { to: 'all', type: 'chat', body: 'hello' });
    await t.human.call('human.post', { projectId: a.session.projectId, to: 'all', body: 'hi team' });
    b.client.close();
    await settle();
    t.advance(3 * MIN);

    const rebuilt = initialModel();
    for (const row of t.hub.store.all()) evolve(rebuilt, row);
    expect(rebuilt).toEqual(t.hub.model);

    const deliveries = () => t.hub.store.reader.all('SELECT project_id, agent_id, gpos, priority, envelope FROM deliveries ORDER BY agent_id, gpos');
    const before = deliveries();
    t.hub.store.rebuildProjections();
    expect(deliveries()).toEqual(before);
  });

  it('survives a hub restart: agents become disconnected, then resume by key within the grace period', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-hub-'));
    try {
      const storePath = join(dir, 'hub.db');
      const first = await TestHub.start({ storePath });
      const a = await first.pair('A', { newProjectName: 'P' });
      await a.client.call('send', { to: 'all', type: 'chat', body: 'before restart' });
      const { hubKey, clock } = first;
      await first.close();

      t = await TestHub.start({ storePath, hubKey, clock });
      expect((await roster(t, a.session.projectId))[0]).toMatchObject({ state: 'active', connected: false });
      t.advance(3 * MIN);
      expect((await roster(t, a.session.projectId))[0]?.state).toBe('stale');
      const back = await t.rejoin(a.identity);
      expect(back.session).toMatchObject({ resumed: true, epoch: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
