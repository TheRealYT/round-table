import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROCEDURES, getProcedure, mcpToolsFor, type PrincipalKind } from '../src/index.ts';

// Spec: Architecture → "MCP tools every agent gets".
const SPEC_AGENT_TOOLS = [
  'join_request', 'join_confirm', 'rejoin', 'leave', 'send', 'wait', 'activity',
  'board_view', 'board_read', 'board_get', 'board_history', 'board_search', 'board_propose', 'board_subscribe',
  'claim', 'release', 'lock', 'unlock', 'request', 'respond', 'ask_human', 'vote', 'log_action',
];
// Spec: "Leader-only tools".
const SPEC_LEADER_TOOLS = [
  'board_commit', 'board_reject', 'broadcast_critical', 'open_vote', 'summarize', 'dismiss', 'history_search', 'history_get',
];
const PAIRING_TOOLS = ['join_request', 'join_confirm', 'rejoin'];

const allows = (name: string, kind: PrincipalKind) =>
  (getProcedure(name)?.allow as readonly PrincipalKind[] | undefined)?.includes(kind) ?? false;

describe('procedure catalog', () => {
  it('has unique names', () => {
    const names = PROCEDURES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes every spec agent tool over MCP', () => {
    for (const name of SPEC_AGENT_TOOLS) expect(getProcedure(name)?.mcp, name).toBe(true);
    for (const name of PAIRING_TOOLS) expect(allows(name, 'unpaired'), name).toBe(true);
  });

  it('gives leader-only tools to the leader and never to workers', () => {
    for (const name of SPEC_LEADER_TOOLS) {
      expect(allows(name, 'leader'), name).toBe(true);
      expect(allows(name, 'worker'), name).toBe(false);
    }
  });

  it('keeps the leader on coordination: no claim, lock, request, respond or vote', () => {
    for (const name of ['claim', 'release', 'lock', 'unlock', 'request', 'respond', 'vote']) {
      expect(allows(name, 'leader'), name).toBe(false);
    }
  });

  it('never exposes human procedures to agents or over MCP', () => {
    for (const p of PROCEDURES.filter((p) => (p.allow as readonly string[]).includes('human') && !SPEC_AGENT_TOOLS.includes(p.name))) {
      if (SPEC_LEADER_TOOLS.includes(p.name) || p.name === 'change_request.get') continue;
      expect(p.mcp, p.name).toBe(false);
      expect(allows(p.name, 'worker') || allows(p.name, 'leader'), p.name).toBe(false);
    }
  });

  it('never lets an internal hub principal be reached through the catalog', () => {
    for (const p of PROCEDURES) expect(p.allow, p.name).not.toContain('hub');
  });

  it('uses MCP-safe names for every MCP tool', () => {
    for (const p of PROCEDURES.filter((p) => p.mcp)) expect(p.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('requires projectId on human-callable project and repo procedures (invariant 8)', () => {
    for (const p of PROCEDURES) {
      if (p.stream === 'system' || !(p.allow as readonly string[]).includes('human')) continue;
      const shape = (p.input as z.ZodObject).shape;
      expect(Object.keys(shape), p.name).toContain('projectId');
    }
  });

  it('shows workers only worker tools, and the unpaired only pairing tools', () => {
    expect(mcpToolsFor('unpaired').map((p) => p.name).sort()).toEqual([...PAIRING_TOOLS].sort());
    const worker = mcpToolsFor('worker').map((p) => p.name);
    for (const name of SPEC_LEADER_TOOLS) expect(worker).not.toContain(name);
  });

  it('ties review and test results to a head sha (ADR-0008)', () => {
    const respond = getProcedure('respond')!.input;
    const sha = 'a'.repeat(40);
    const base = { requestId: 'req_00000000000000000000000001' };
    expect(respond.safeParse({ ...base, result: { kind: 'review', verdict: 'approved', headSha: sha } }).success).toBe(true);
    expect(respond.safeParse({ ...base, result: { kind: 'review', verdict: 'approved' } }).success).toBe(false);
    expect(respond.safeParse({ ...base, result: { kind: 'test', status: 'pass', evidence: 'ok' } }).success).toBe(false);
  });
});
