import { z } from 'zod';
import {
  getProcedure,
  PROTOCOL_VERSION,
  type AgentId,
  type EventRow,
  type PairingId,
  type PrincipalKind,
  type StreamId,
} from '@round-table/protocol';
import {
  fingerprint,
  generatePairingCode,
  hashPairingCode,
  joinConfirmMessage,
  verifyMessage,
} from '@round-table/protocol/crypto';
import { INTERNAL_COMMANDS, nextStep, type ProjectRecord } from '@round-table/core';
import { boardGet, boardRead, boardView } from './board-queries.ts';
import type { HubInternals } from './internals.ts';
import { ackDeliveries, pendingDeliveries } from './projectors/deliveries.ts';
import { agentOf, RpcError, type Session } from './session.ts';

type Handler = (session: Session, input: any) => unknown | Promise<unknown>;

/**
 * Routes one procedure call (ADR-0011): look it up in the catalog, check the caller's principal,
 * validate the input, then run a query against the read models or dispatch a command to the bus.
 * Commands that need crypto get it here, so core only sees plain facts (hashes, booleans).
 */
export class Router {
  private readonly hub: HubInternals;
  private readonly queries: Record<string, Handler>;
  private readonly commands: Record<string, Handler>;
  /**
   * When each agent last called a tool, and whether it is inside wait. Operational state, not
   * events: it shows the human which agents' models stopped (an MCP server cannot wake a model).
   */
  private readonly attention = new Map<string, { lastCallAt: number; waiting: boolean }>();

  constructor(hub: HubInternals) {
    this.hub = hub;
    this.queries = {
      'hub.info': () => ({ hubId: hub.hubId, hubPublicKey: hub.hubKey.publicKey, version: PROTOCOL_VERSION }),
      'project.list': () => Object.values(hub.model.projects).map((p) => ({
        projectId: p.projectId,
        name: p.name,
        createdAt: p.createdAt,
        leaderId: p.leaderId,
        agents: Object.values(p.roster).filter((e) => e.state === 'active' || e.state === 'stale').length,
      })),
      'pairing.list': () => ({
        requests: Object.values(hub.model.pairing)
          .filter((r) => r.status === 'pending' || r.status === 'allowed')
          .map(({ codeHash: _hidden, ...r }) => r),
        agents: Object.values(hub.model.agents).map((a) => {
          const entry = hub.model.projects[a.projectId]?.roster[a.agentId];
          return { ...a, role: entry?.role ?? null, state: entry?.state ?? null, connected: entry?.connected ?? false };
        }),
      }),
      board_read: (session, input: { section: string; projectId?: string; filter?: Record<string, unknown>; fields?: string[]; limit: number }) => {
        const project = this.project(session, input.projectId);
        const out = boardRead(project, input);
        if (input.section !== 'roster' || session.principal.kind !== 'human') return out;
        // For the human: is each agent's model still calling tools, and does work wait for it? (ADR-0002 attention)
        return {
          ...out,
          records: out.records.map((r) => {
            const id = r.agentId as AgentId;
            const seen = this.attention.get(id);
            return { ...r, attention: seen ?? null, next: project.roster[id] ? nextStep(hub.model, project.projectId, id) : null };
          }),
        };
      },
      board_view: (session, input: { view: string; projectId?: string }) =>
        boardView(hub.model, this.project(session, input.projectId), input.view, agentOf(session)?.agentId as AgentId | undefined),
      board_get: (session, input: { id: string; projectId?: string }) => boardGet(this.project(session, input.projectId), input.id),
      board_history: (session, input: { id: string; projectId?: string }) => {
        const project = this.project(session, input.projectId);
        return { id: input.id, events: hub.store.historyOf(project.projectId, input.id) };
      },
      'logs.query': (session, input: { projectId: string; filter: { sinceSeq?: number; types?: string[]; last?: boolean }; limit: number }) => {
        const projectId = this.projectFor(session, input.projectId);
        const stream = `project:${projectId}` as StreamId;
        const since = typeof input.filter.sinceSeq === 'number' ? input.filter.sinceSeq : 0;
        const types = Array.isArray(input.filter.types) ? new Set(input.filter.types) : undefined;
        // `last: true` returns the newest events (the Feed); otherwise events after sinceSeq (the Logs view).
        const rows = input.filter.last === true ? hub.store.tail(stream, input.limit) : hub.store.read(stream, since, input.limit);
        return { events: types ? rows.filter((r: EventRow) => types.has(r.type)) : rows };
      },
      wait: (session, input: { timeoutMs?: number; ack: number[] }) => this.wait(session, input),
      'agent.next': (session) => {
        const agent = agentOf(session)!;
        return nextStep(hub.model, agent.projectId as never, agent.agentId as AgentId);
      },
    };
    this.commands = {
      join_request: (session, input: { publicKey: string }) => {
        const fp = fingerprintOrThrow(input.publicKey);
        const out = this.dispatch(session, 'join_request', { ...input, fingerprint: fp }) as { requestId: string; matchPhrase: string };
        return { ...out, hubPublicKey: hub.hubKey.publicKey, hubId: hub.hubId };
      },
      join_confirm: (session, input: { requestId: PairingId; code: string; signature: string }) => {
        const request = hub.model.pairing[input.requestId];
        const signatureValid = request !== undefined && verifyMessage(request.publicKey, joinConfirmMessage(input.requestId, input.code), input.signature);
        const out = this.dispatch(session, 'join_confirm', { requestId: input.requestId, codeHash: hashPairingCode(input.code), signatureValid });
        return { ...(out as object), hubId: hub.hubId, hubPublicKey: hub.hubKey.publicKey };
      },
      // Change requests: the hub reads branch heads from git so verdicts are tied to exact commits (ADR-0008).
      board_propose: async (session, input: { section: string; op: string; data: unknown; projectId?: string }) => {
        if (input.section !== 'artifacts') return this.dispatch(session, 'board_propose', input);
        const project = this.project(session, undefined);
        const data = (input.data ?? {}) as { branch?: unknown; changeRequestId?: unknown };
        const branch = input.op === 'update'
          ? project.changeRequests[String(data.changeRequestId) as never]?.branch
          : typeof data.branch === 'string' ? data.branch : undefined;
        return this.dispatch(session, 'board_propose', { ...input, headSha: branch ? await this.head(project, branch) : null });
      },
      request: async (session, input: { ref: string }) => {
        const project = this.project(session, undefined);
        const cr = project.changeRequests[input.ref as never] ?? project.changeRequests[project.tasks[input.ref as never]?.changeRequestId as never];
        return this.dispatch(session, 'request', { ...input, currentHeadSha: cr ? await this.head(project, cr.branch) : null });
      },
      respond: async (session, input: { requestId: string }) => {
        const project = this.project(session, undefined);
        const request = project.requests[input.requestId as never];
        const cr = request ? project.changeRequests[request.changeRequestId] : undefined;
        return this.dispatch(session, 'respond', { ...input, currentHeadSha: cr ? await this.head(project, cr.branch) : null });
      },
      'repo.attach': async (session, input: { projectId: string; path: string; mainBranch: string }) => {
        const top = await hub.git.topLevel(input.path);
        if (!top) throw new RpcError('invalid_input', `${input.path} is not a git repository`);
        if (!(await hub.git.resolveBranch(top, input.mainBranch))) throw new RpcError('invalid_input', `branch ${input.mainBranch} does not exist in ${top}`);
        const out = this.dispatch(session, 'repo.attach', { ...input, path: top }) as { repoId: string };
        const checkedOut = (await hub.git.checkedOutBranches(top)).includes(input.mainBranch);
        return {
          ...out,
          path: top,
          ...(checkedOut && {
            warning: `${input.mainBranch} is checked out in a worktree of this repository. The hub moves ${input.mainBranch} when it merges, which leaves that checkout out of date; detach it (git switch --detach) or keep ${input.mainBranch} unchecked-out.`,
          }),
        };
      },
      'pairing.allow': (session, input: object) => {
        const code = generatePairingCode();
        const out = this.dispatch(session, 'pairing.allow', { ...input, codeHash: hashPairingCode(code) }) as { projectId: string; expiresAt: number };
        return { code, ...out };
      },
    };
  }

  async handle(session: Session, name: string, rawInput: unknown): Promise<unknown> {
    const def = getProcedure(name);
    if (!def) throw new RpcError('unknown_procedure', `no procedure "${name}"`);
    if (!(def.allow as readonly PrincipalKind[]).includes(session.principal.kind)) {
      throw new RpcError('forbidden', `${session.principal.kind} may not call ${name}`);
    }
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) throw new RpcError('invalid_input', z.prettifyError(parsed.error), parsed.error.issues);
    const input = parsed.data as { projectId?: string };
    const agent = agentOf(session);
    if (agent && input.projectId !== undefined && input.projectId !== agent.projectId) {
      throw new RpcError('forbidden', 'agents can only act in their own project');
    }
    if (agent) this.attention.set(agent.agentId, { lastCallAt: this.hub.clock.now(), waiting: name === 'wait' });
    const special = def.kind === 'query' ? this.queries[name] : this.commands[name];
    if (special) return special(session, input);
    if (def.kind === 'command' && !INTERNAL_COMMANDS.has(name)) return this.dispatch(session, name, input);
    throw new RpcError('unknown_procedure', `${name} is not built yet (see docs/architecture/build-plan.md)`);
  }

  private dispatch(session: Session, name: string, input: unknown): unknown {
    const result = this.hub.bus.dispatch(name, input, session.principal);
    if (result.ok) return result.output ?? { ok: true };
    const { code, message, details } = result.rejection;
    if (code === 'unknown_command') throw new RpcError('unknown_procedure', `${name} is not built yet (see docs/architecture/build-plan.md)`);
    if (code === 'internal') throw new RpcError('internal', message);
    throw new RpcError('rejected', message, { code, ...details });
  }

  private project(session: Session, projectId: string | undefined): ProjectRecord {
    return this.hub.model.projects[this.projectFor(session, projectId) as never]!;
  }

  /** Current head of a branch in the project's repository, or null. */
  private async head(project: ProjectRecord, branch: string): Promise<string | null> {
    const repo = project.repoId ? this.hub.model.repos[project.repoId] : undefined;
    return repo ? this.hub.git.resolveBranch(repo.path, branch) : null;
  }

  private projectFor(session: Session, projectId: string | undefined): string {
    const agent = agentOf(session);
    const id = agent?.projectId ?? projectId;
    if (!id) throw new RpcError('invalid_input', 'projectId is required');
    if (!this.hub.model.projects[id as never]) throw new RpcError('rejected', 'no such project', { code: 'unknown_project' });
    return id;
  }

  private async wait(session: Session, input: { timeoutMs?: number; ack: number[] }) {
    const agent = agentOf(session);
    if (!agent) throw new RpcError('forbidden', 'agents only');
    const { store, waiters, clock, config } = this.hub;
    ackDeliveries(store.reader, agent.agentId, input.ack, clock.now());
    let result = pendingDeliveries(store.reader, agent.agentId, config.waitMaxChars);
    if (result.items.length === 0) {
      const timeout = Math.min(input.timeoutMs ?? config.waitMaxMs, config.waitMaxMs);
      try {
        await waiters.wait(agent.agentId, timeout);
      } finally {
        this.attention.set(agent.agentId, { lastCallAt: clock.now(), waiting: false });
      }
      if (session.fenced) throw new RpcError('fenced', 'this session was replaced by a newer one');
      result = pendingDeliveries(store.reader, agent.agentId, config.waitMaxChars);
    }
    this.hub.pushInbox(agent.agentId);
    return { items: result.items.map((d) => ({ deliveryId: d.deliveryId, ...d.message })), more: result.more };
  }
}

function fingerprintOrThrow(publicKey: string): string {
  // A valid Ed25519 SPKI key verifies nothing but must parse; verifyMessage returns false on junk.
  if (!/^[A-Za-z0-9+/]+=*$/.test(publicKey) || Buffer.from(publicKey, 'base64').length !== 44) {
    throw new RpcError('invalid_input', 'publicKey must be a base64 Ed25519 SPKI key');
  }
  return fingerprint(publicKey);
}
