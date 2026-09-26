import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravityDriver, serverName, type AgentProcess, type DriverEvent, type DriverStart } from '@round-table/hub';

const FAKE = resolve(import.meta.dirname, '../fixtures/fake-agy.mjs');
let dir: string;
let proc: AgentProcess | undefined;
afterEach(() => proc?.stop());

function start(overrides: Partial<DriverStart> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'fake-agy-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const events: DriverEvent[] = [];
  proc = new AntigravityDriver().start(
    {
      agentId: 'agt_01TESTAAAAAAAAAAAAAA4K2P9Z',
      agentName: 'Ada',
      command: FAKE,
      cwd: dir,
      env: { FAKE_AGY_LOG: log },
      mcp: { command: 'node', args: ['rt', 'agent', 'run', '--driven'], env: { RT_HOME: '/data/agents/ada/home' } },
      systemPrompt: 'You are Ada, an AI agent on a Round Table team.',
      model: '',
      extraArgs: [],
      resumeSessionId: null,
      ...overrides,
    },
    (e) => events.push(e),
  );
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  return { events, calls };
}

const turnEnds = (events: DriverEvent[]) => events.filter((e) => e.type === 'turn_end');

describe('Antigravity driver (S8: agy 1.2.11)', () => {
  it('registers the agent’s rt-agent with agy mcp add, and opens a new conversation with the Round Table instructions', async () => {
    const { events, calls } = start();
    const server = serverName('Ada', 'agt_01TESTAAAAAAAAAAAAAA4K2P9Z');
    expect(server).toBe('rt-ada-4k2p9z');
    expect(calls()[0]).toEqual(['mcp', 'add', '-e', 'RT_HOME=/data/agents/ada/home', server, 'node', 'rt', 'agent', 'run', '--driven']);

    proc!.send('[Round Table] You are Ada.');
    await expect.poll(() => turnEnds(events).length).toBe(1);
    const run = calls()[1]!;
    expect(run.slice(0, 1)).toEqual(['-p']);
    expect(run[1]).toContain('You are Ada, an AI agent on a Round Table team.');
    expect(run[1]).toContain(`the MCP server named "${server}"`);
    expect(run).toContain('--dangerously-skip-permissions');
    expect(run).not.toContain('--conversation');

    const session = events.find((e) => e.type === 'session');
    expect(session).toBeDefined();
    expect(events).toContainEqual({ type: 'tool', id: 'step-1', name: 'mcp__rt-ada__report', input: '{"text":"done"}' });
    expect(events).toContainEqual({ type: 'tool_result', id: 'step-1', output: 'recorded', isError: false });
    expect(events).toContainEqual({ type: 'thinking', text: '', tokens: 7 });
    expect(events).toContainEqual({ type: 'text', text: 'All done.' });
    expect(turnEnds(events)[0]).toEqual({ type: 'turn_end', ok: true, durationMs: 2500, sessionCostUsd: null, inputTokens: 150, outputTokens: 25, error: null });

    // The next message continues the conversation, without the instructions again.
    proc!.send('[Round Table] next: claim the task.');
    await expect.poll(() => turnEnds(events).length).toBe(2);
    const next = calls()[2]!;
    expect(next).toEqual(expect.arrayContaining(['--conversation', (session as { sessionId: string }).sessionId]));
    expect(next[1]).toBe('[Round Table] next: claim the task.');
  });

  it('interrupts a turn with SIGINT; the next message still runs', async () => {
    const { events } = start();
    proc!.send('SLOW: call fetch_plan');
    await expect.poll(() => events.some((e) => e.type === 'tool')).toBe(true);
    proc!.interrupt();
    await expect.poll(() => turnEnds(events).length).toBe(1);
    expect(turnEnds(events)[0]).toMatchObject({ ok: false, error: 'interrupted' });
    expect(events.some((e) => e.type === 'exit')).toBe(false);
    proc!.send('carry on');
    await expect.poll(() => turnEnds(events).length).toBe(2);
    expect(turnEnds(events)[1]).toMatchObject({ ok: true });
  });

  it('reports a turn that never got going (e.g. not signed in) as a crash, so the supervisor backs off', async () => {
    const { events } = start();
    proc!.send('FAILSTART');
    await expect.poll(() => events.find((e) => e.type === 'exit')).toMatchObject({ type: 'exit', code: 1, error: expect.stringContaining('Not signed in') });
    expect(turnEnds(events)).toHaveLength(0);
  });

  it('resumes a known conversation without repeating the instructions, and unregisters its server on stop', async () => {
    const { events, calls } = start({ resumeSessionId: 'conv-123' });
    proc!.send('[Round Table] The Round Table restarted you.');
    await expect.poll(() => turnEnds(events).length).toBe(1);
    expect(calls()[1]).toEqual(expect.arrayContaining(['--conversation', 'conv-123']));
    expect(calls()[1]![1]).toBe('[Round Table] The Round Table restarted you.');
    proc!.stop();
    proc = undefined;
    await expect.poll(() => events.some((e) => e.type === 'exit')).toBe(true);
    expect(calls().at(-1)).toEqual(['mcp', 'remove', 'rt-ada-4k2p9z']);
  });
});
