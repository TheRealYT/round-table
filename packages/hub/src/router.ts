import { z } from 'zod';
import {
  getProcedure,
  PROTOCOL_VERSION,
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
import { INTERNAL_COMMANDS } from '@round-table/core';
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
      board_read: (session, input: { section: string; projectId?: string }) => {
        const projectId = this.projectFor(session, input.projectId);
        if (input.section !== 'roster') {
          throw new RpcError('unknown_procedure', `board_read("${input.section}") arrives in slice S2/S3; only "roster" exists in S1`);
        }
        return { section: 'roster', records: Object.values(hub.model.projects[projectId as never]?.roster ?? {}) };
      },
      'logs.query': (session, input: { projectId: string; filter: { sinceSeq?: number; types?: string[] }; limit: number }) => {
        const projectId = this.projectFor(session, input.projectId);
        const since = typeof input.filter.sinceSeq === 'number' ? input.filter.sinceSeq : 0;
        const types = Array.isArray(input.filter.types) ? new Set(input.filter.types) : undefined;
        const rows = hub.store.read(`project:${projectId}` as StreamId, since, input.limit);
        return { events: types ? rows.filter((r: EventRow) => types.has(r.type)) : rows };
      },
      wait: (session, input: { timeoutMs?: number; ack: number[] }) => this.wait(session, input),
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
      await waiters.wait(agent.agentId, timeout);
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
