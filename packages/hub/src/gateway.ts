import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type AgentId,
  type ConnectionInfo,
  type EventPayloads,
  type EventRow,
  type Frame,
  type Principal,
  type ProjectId,
  type Transport,
  type TransportListener,
} from '@round-table/protocol';
import { challengeMessage, challengeResponseMessage, signMessage, verifyMessage } from '@round-table/protocol/crypto';
import type { HubInternals } from './internals.ts';
import { deliveryTargets, inboxCounts } from './projectors/deliveries.ts';
import type { Router } from './router.ts';
import { agentOf, RpcError, type Session } from './session.ts';

const HUB_PRINCIPAL: Principal = { kind: 'hub', component: 'gateway' };

/**
 * Turns connections into sessions (architecture §3): decides who each connection is, runs the
 * rejoin challenge, fences replaced sessions, and pushes inbox counts and change notices after
 * every commit. Nothing here decides domain rules; that is core's job via the bus.
 */
export class Gateway {
  private readonly hub: HubInternals;
  private readonly router: Router;
  private readonly isHumanSession: (cookieValue: string) => boolean;
  private readonly sessions = new Set<Session>();
  private readonly challenges = new Map<string, { agentId: string; ts: number; sessionId: number }>();
  private nextId = 1;

  constructor(hub: HubInternals, router: Router, isHumanSession: (cookieValue: string) => boolean) {
    this.hub = hub;
    this.router = router;
    this.isHumanSession = isHumanSession;
    hub.bus.onCommit((rows) => this.afterCommit(rows));
  }

  attach(listener: TransportListener): () => void {
    return listener.onConnection((transport, info) => this.accept(transport, info));
  }

  get liveSessions(): readonly Session[] {
    return [...this.sessions];
  }

  closeAll(): void {
    for (const s of this.sessions) s.transport.close('hub shutting down');
  }

  private accept(transport: Transport, info: ConnectionInfo): void {
    let principal: Principal;
    if (info.endpoint === 'app') {
      const cookie = parseCookie(info.cookie ?? '')['rt_session'];
      if (!cookie || !this.isHumanSession(cookie)) {
        sendError(transport, '-', 'unauthenticated', 'log in with the URL printed by `rt hub start`');
        transport.close('unauthenticated');
        return;
      }
      principal = { kind: 'human', humanId: 'owner' };
    } else {
      principal = { kind: 'unpaired', origin: info.origin ?? info.remoteAddress };
    }
    const session: Session = { id: this.nextId++, transport, info, principal, fenced: false };
    this.sessions.add(session);
    transport.onFrame((frame) => void this.onFrame(session, frame));
    transport.onClose(() => this.onClose(session));
  }

  private async onFrame(session: Session, frame: Frame): Promise<void> {
    if (frame.type !== 'req') return;
    const { proc, input } = frame.payload;
    try {
      if (session.fenced) throw new RpcError('fenced', 'this session was replaced by a newer one');
      const output =
        proc === 'session.challenge' ? this.challenge(session, input)
        : proc === 'session.prove' ? this.prove(session, input)
        : proc === 'rejoin' ? rejoinHint()
        : await this.router.handle(session, proc, input);
      if (session.transport.state === 'open') {
        session.transport.send({ v: PROTOCOL_VERSION, id: frame.id, type: 'res', payload: { output: output ?? null } });
      }
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError('internal', error instanceof Error ? error.message : String(error));
      if (session.transport.state === 'open') sendError(session.transport, frame.id, e.code, e.message, e.details);
    }
  }

  /** Step 1 of rejoin: a fresh nonce, signed by the hub so the agent can tell it is the real hub. */
  private challenge(session: Session, input: unknown) {
    if (session.principal.kind !== 'unpaired') throw new RpcError('forbidden', 'already authenticated');
    const agentId = (input as { agentId?: unknown })?.agentId;
    if (typeof agentId !== 'string') throw new RpcError('invalid_input', 'agentId is required');
    const nonce = randomBytes(24).toString('base64url');
    const ts = this.hub.clock.now();
    this.challenges.set(nonce, { agentId, ts, sessionId: session.id });
    const hubSignature = signMessage(this.hub.hubKey.privateKey, challengeMessage({ hubId: this.hub.hubId, agentId, nonce, ts }));
    return { nonce, hubId: this.hub.hubId, ts, hubSignature };
  }

  /** Step 2: the agent's signature over the challenge. Opens a new epoch and fences older sessions. */
  private prove(session: Session, input: unknown) {
    const { agentId, nonce, signature } = (input ?? {}) as { agentId?: string; nonce?: string; signature?: string };
    const issued = nonce ? this.challenges.get(nonce) : undefined;
    if (nonce) this.challenges.delete(nonce); // single use
    if (!issued || issued.sessionId !== session.id || issued.agentId !== agentId || !signature) {
      throw new RpcError('unauthenticated', 'unknown or reused challenge');
    }
    if (this.hub.clock.now() - issued.ts > this.hub.config.challengeTtlMs) throw new RpcError('unauthenticated', 'challenge expired');
    const agent = this.hub.model.agents[agentId as AgentId];
    const message = challengeResponseMessage({ hubId: this.hub.hubId, agentId: agentId!, nonce: nonce!, ts: issued.ts });
    if (!agent || !verifyMessage(agent.publicKey, message, signature)) throw new RpcError('unauthenticated', 'signature does not match the paired key');

    const result = this.hub.bus.dispatch('session.open', { agentId }, HUB_PRINCIPAL);
    if (!result.ok) throw new RpcError('rejected', result.rejection.message, { code: result.rejection.code });
    const out = result.output as { epoch: number; projectId: ProjectId; role: 'worker' | 'leader'; resumed: boolean };
    for (const other of this.sessions) {
      if (other !== session && agentOf(other)?.agentId === agentId) this.fence(other);
    }
    session.principal = { kind: out.role, agentId: agentId as AgentId, projectId: out.projectId, epoch: out.epoch };
    this.pushInbox(agentId!);
    return out;
  }

  private fence(session: Session): void {
    session.fenced = true;
    const agent = agentOf(session);
    if (agent) this.hub.waiters.cancel(agent.agentId);
    push(session, 'fenced', { reason: 'a newer session proved the same key' });
    session.transport.close('fenced');
  }

  private onClose(session: Session): void {
    this.sessions.delete(session);
    const agent = agentOf(session);
    if (!agent || session.fenced) return;
    this.hub.waiters.cancel(agent.agentId);
    this.hub.bus.dispatch('session.closed', { agentId: agent.agentId, epoch: agent.epoch }, HUB_PRINCIPAL);
  }

  pushInbox(agentId: string): void {
    const targets = [...this.sessions].filter((s) => agentOf(s)?.agentId === agentId);
    if (targets.length === 0) return;
    const counts = inboxCounts(this.hub.store.reader, agentId);
    for (const s of targets) push(s, 'inbox', counts);
  }

  private afterCommit(rows: EventRow[]): void {
    const touched = new Map<string, EventRow['type'][]>();
    for (const row of rows) {
      for (const { agentId, priority } of deliveryTargets(row)) {
        this.hub.waiters.notify(agentId, priority);
        touched.set(agentId, []);
      }
      if (row.type === 'roster.role_changed') {
        const { agentId, role } = row.payload as EventPayloads['roster.role_changed'];
        for (const s of this.sessions) {
          const p = s.principal;
          if ((p.kind === 'worker' || p.kind === 'leader') && p.agentId === agentId) {
            s.principal = { ...p, kind: role };
            push(s, 'role', { role });
          }
        }
      }
    }
    for (const agentId of touched.keys()) this.pushInbox(agentId);
    // The human app refetches what changed; it never replays events itself (architecture §7).
    const notice = {
      streams: [...new Set(rows.map((r) => r.stream))],
      types: [...new Set(rows.map((r) => r.type))],
      lastGpos: rows[rows.length - 1]?.gpos ?? 0,
    };
    for (const s of this.sessions) if (s.principal.kind === 'human') push(s, 'changed', notice);
  }
}

function push(session: Session, topic: string, data: unknown): void {
  if (session.transport.state !== 'open') return;
  session.transport.send({ v: PROTOCOL_VERSION, id: `evt-${topic}`, type: 'evt', payload: { topic, data } });
}

function sendError(transport: Transport, id: string, code: RpcError['code'], message: string, details?: unknown): void {
  if (transport.state !== 'open') return;
  transport.send({ v: PROTOCOL_VERSION, id, type: 'err', payload: details === undefined ? { code, message } : { code, message, details } });
}

function rejoinHint(): never {
  throw new RpcError('invalid_input', 'rejoin runs as session.challenge + session.prove; rt-agent does this automatically');
}

export function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
