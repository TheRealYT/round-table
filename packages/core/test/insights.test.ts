import { describe, expect, it } from 'vitest';
import { computeInsights, turnTrigger, type InsightRow, type InsightStep } from '../src/insights.ts';

const S = 1_000;
const row = (ts: number, type: string, payload: Record<string, unknown>): InsightRow => ({ ts, type, actor: 'hub', payload });
const msg = (ts: number, to: unknown, recipients: string[]) => row(ts, 'message.sent', { to, role: 'worker', priority: 'normal', recipients });

describe('insights: where the time went', () => {
  const rows: InsightRow[] = [
    row(0, 'roster.joined', { agentId: 'L', name: 'Lead', role: 'worker' }),
    row(0, 'roster.joined', { agentId: 'A', name: 'Ada', role: 'worker' }),
    row(0, 'roster.joined', { agentId: 'B', name: 'Bo', role: 'worker' }),
    row(1 * S, 'roster.role_changed', { agentId: 'L', role: 'leader' }),
    row(10 * S, 'task.created', { taskId: 't1', title: 'Board logic' }),
    row(20 * S, 'task.created', { taskId: 't2', title: 'Page' }),
    // The human approves 40 s after the last task was proposed.
    row(60 * S, 'task.status_changed', { taskId: 't1', from: 'proposed', to: 'ready' }),
    row(60 * S, 'task.status_changed', { taskId: 't2', from: 'proposed', to: 'ready' }),
    row(70 * S, 'task.claimed', { taskId: 't1', owner: 'A' }),
    row(80 * S, 'task.claimed', { taskId: 't2', owner: 'B' }),
    row(170 * S, 'change_request.opened', { changeRequestId: 'c1', taskId: 't1' }),
    msg(171 * S, 'all', ['L', 'B']),
    row(200 * S, 'change_request.rebase_needed', { changeRequestId: 'c1' }),
    row(230 * S, 'change_request.updated', { changeRequestId: 'c1' }),
    row(290 * S, 'merge.requested', { changeRequestId: 'c1' }),
    row(320 * S, 'quality.test_run', { changeRequestId: 'c1', status: 'pass', durationMs: 25 * S }),
    row(320 * S, 'task.status_changed', { taskId: 't1', from: 'in_test', to: 'done' }),
    row(100 * S, 'agent.turn_finished', { agentId: 'A', durationMs: 30 * S, costUsd: 0.2, inputTokens: 1000, outputTokens: 200 }),
    row(172 * S, 'agent.turn_finished', { agentId: 'L', durationMs: 2 * S, costUsd: 0.01, inputTokens: 100, outputTokens: 10 }),
  ];
  const steps: InsightStep[] = [
    { agentId: 'A', at: 69 * S, kind: 'to_agent', text: '[Round Table] You are Ada, the worker on project "P".', data: null },
    { agentId: 'A', at: 100 * S, kind: 'turn', text: 'turn done', data: { durationMs: 30 * S, costUsd: 0.2 } },
    { agentId: 'L', at: 170 * S, kind: 'to_agent', text: '[Round Table] message from Ada (chat): I opened a change request', data: null },
    { agentId: 'L', at: 172 * S, kind: 'turn', text: 'turn done', data: { durationMs: 2 * S, costUsd: 0.01 } },
  ];
  const x = computeInsights(rows, steps);

  it('splits each task into approval, claim, coding, verify and hub phases', () => {
    const t1 = x.tasks.find((t) => t.taskId === 't1')!;
    expect(t1.phases).toEqual({ approval: 50 * S, toClaim: 10 * S, coding: 100 * S, verify: 120 * S, hubRun: 30 * S });
    expect(t1).toMatchObject({ status: 'done', leadMs: 310 * S, reworks: 1, conflicts: 1 });
    expect(x.tasks.find((t) => t.taskId === 't2')!.phases.coding).toBeNull();
  });

  it('counts approval wait once per approval, from the newest proposal', () => {
    expect(x.totals.approvalWaitMs).toBe(40 * S);
  });

  it('sums turns per agent and says what started them', () => {
    const ada = x.agents.find((a) => a.name === 'Ada')!;
    expect(ada).toMatchObject({ turns: 1, workingMs: 30 * S, tokens: 1200, byTrigger: { kickoff: { turns: 1, ms: 30 * S, costUsd: 0.2 } } });
    const lead = x.agents[0]!;
    expect(lead).toMatchObject({ name: 'Lead', role: 'leader', shortTurns: 1, byTrigger: { agent: { turns: 1 } } });
  });

  it('counts broadcasts, deliveries, conflicts and parallel work', () => {
    expect(x.totals).toMatchObject({ messages: 1, broadcasts: 1, deliveries: 2, conflicts: 1, hubRuns: 1, hubRunMs: 25 * S, peakParallel: 2 });
  });

  it('writes findings a person can act on, biggest first', () => {
    expect(x.findings.join('\n')).toMatch(/approve the plan took 40 s/);
    expect(x.findings.join('\n')).toMatch(/1 message was sent to everyone/);
  });
});

describe('turn triggers from session steps', () => {
  it.each([
    ['[Round Table] You are Ada, the worker', 'kickoff'],
    ['[Round Table] The Round Table restarted you.', 'kickoff'],
    ['[Round Table] next: claim task t1', 'nudge'],
    ['[Round Table] HUMAN message from the human (human): stop', 'human'],
    ['[Round Table] CRITICAL message from Lead (alert): main is broken', 'critical'],
    ['[Round Table] message from the hub (alert): "x" is done', 'hub'],
    ['[Round Table] message from Bo (chat): hi', 'agent'],
  ])('%s → %s', (text, trigger) => {
    expect(turnTrigger({ text, data: null })).toBe(trigger);
  });

  it('prefers the trigger the supervisor recorded', () => {
    expect(turnTrigger({ text: 'anything', data: { trigger: 'broadcast' } })).toBe('broadcast');
  });
});
