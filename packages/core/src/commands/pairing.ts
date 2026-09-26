import type { AgentId, PairingId, ProjectId } from '@round-table/protocol';
import { authorOf, HUB, inProject, makeEvent, SYSTEM } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';
import type { Model, PairingRecord } from '../model.ts';
import { matchPhrase } from './phrase.ts';
import { cancelTimers, inputField, schedule } from './timers.ts';

/**
 * Pairing (spec: Pairing). The hub prepares what needs crypto before these handlers run:
 * key fingerprints, code hashes and signature checks arrive as plain input fields.
 */

const forRequest = (requestId: string) => (c: { name: string; input: unknown }) =>
  c.name.startsWith('pairing.') && inputField(c.input, 'requestId') === requestId;

export const joinRequest: CommandHandler<{
  name: string;
  client: string;
  tags: string[];
  capabilities: string[];
  publicKey: string;
  fingerprint: string;
}> = (model, command, ctx) => {
  if (command.principal.kind !== 'unpaired') return reject('forbidden', 'already paired');
  const origin = command.principal.origin;
  if (model.blockedOrigins[origin]) return reject('origin_blocked', 'this origin is blocked from pairing');
  const pending = Object.values(model.pairing).filter((p) => p.origin === origin && (p.status === 'pending' || p.status === 'allowed'));
  if (pending.length >= ctx.settings.pairingMaxPendingPerOrigin) {
    return reject('rate_limited', 'too many pending join requests from this origin');
  }
  const { publicKey } = command.input;
  if (Object.values(model.agents).some((a) => a.publicKey === publicKey && !a.revoked)) {
    return reject('key_in_use', 'this key is already paired; rejoin instead');
  }
  const requestId = ctx.ids.next('pairing') as PairingId;
  const phrase = matchPhrase(ctx.random);
  const expiresAt = ctx.now + ctx.settings.pairingRequestTtlMs;
  return accept(
    [
      makeEvent(ctx, HUB, SYSTEM, 'pairing.requested', { requestId, ...command.input, origin, matchPhrase: phrase, expiresAt }),
      schedule(ctx, SYSTEM, expiresAt, 'pairing.expire', { requestId }),
    ],
    { requestId, matchPhrase: phrase },
  );
};

function project(model: Readonly<Model>, projectId: ProjectId | undefined) {
  return projectId === undefined ? undefined : model.projects[projectId];
}

export const allowPairing: CommandHandler<{
  requestId: PairingId;
  projectId?: ProjectId;
  newProjectName?: string;
  codeHash: string;
}> = (model, command, ctx) => {
  const request = model.pairing[command.input.requestId];
  if (!request || request.status !== 'pending') return reject('not_pending', 'no pending join request with that id');
  const author = authorOf(command.principal);
  const events = [];
  let projectId = command.input.projectId;
  if (projectId !== undefined) {
    if (!project(model, projectId)) return reject('unknown_project', 'no such project');
  } else {
    if (!command.input.newProjectName) return reject('invalid_input', 'choose a project or name a new one');
    projectId = ctx.ids.next('project') as ProjectId;
    events.push(makeEvent(ctx, author, SYSTEM, 'project.created', { projectId, name: command.input.newProjectName }));
  }
  const codeExpiresAt = ctx.now + ctx.settings.pairingCodeTtlMs;
  events.push(
    ...cancelTimers(model, ctx, SYSTEM, forRequest(request.requestId)),
    makeEvent(ctx, author, SYSTEM, 'pairing.allowed', { requestId: request.requestId, projectId, codeHash: command.input.codeHash, codeExpiresAt }),
    schedule(ctx, SYSTEM, codeExpiresAt, 'pairing.code_expire', { requestId: request.requestId }),
  );
  return accept(events, { projectId, expiresAt: codeExpiresAt });
};

export const denyPairing: CommandHandler<{ requestId: PairingId }> = (model, command, ctx) => {
  const request = model.pairing[command.input.requestId];
  if (!request || (request.status !== 'pending' && request.status !== 'allowed')) return reject('not_pending', 'no open join request with that id');
  return accept([
    ...cancelTimers(model, ctx, SYSTEM, forRequest(request.requestId)),
    makeEvent(ctx, authorOf(command.principal), SYSTEM, 'pairing.denied', { requestId: request.requestId }),
  ]);
};

export const blockOrigin: CommandHandler<{ origin: string }> = (model, command, ctx) => {
  const author = authorOf(command.principal);
  const open = Object.values(model.pairing).filter((p) => p.origin === command.input.origin && (p.status === 'pending' || p.status === 'allowed'));
  return accept([
    makeEvent(ctx, author, SYSTEM, 'pairing.origin_blocked', { origin: command.input.origin }),
    ...open.flatMap((p) => [
      ...cancelTimers(model, ctx, SYSTEM, forRequest(p.requestId)),
      makeEvent(ctx, author, SYSTEM, 'pairing.denied', { requestId: p.requestId }),
    ]),
  ]);
};

export const joinConfirm: CommandHandler<{ requestId: PairingId; codeHash: string; signatureValid: boolean }> = (model, command, ctx) => {
  const request: PairingRecord | undefined = model.pairing[command.input.requestId];
  if (!request || request.status !== 'allowed' || request.projectId === null) {
    return reject('not_allowed', 'this join request has not been allowed (or is no longer open)');
  }
  if (request.codeExpiresAt !== null && ctx.now >= request.codeExpiresAt) return reject('code_expired', 'the code has expired; ask the human for a new one');
  if (!command.input.signatureValid || command.input.codeHash !== request.codeHash) {
    const attempts = request.attempts + 1;
    const events = [makeEvent(ctx, HUB, SYSTEM, 'pairing.code_failed', { requestId: request.requestId, attempts })];
    if (attempts >= ctx.settings.pairingMaxAttempts) {
      events.push(
        ...cancelTimers(model, ctx, SYSTEM, forRequest(request.requestId)),
        makeEvent(ctx, HUB, SYSTEM, 'pairing.voided', { requestId: request.requestId, reason: 'too_many_attempts' }),
      );
      return reject('voided', 'too many wrong codes; the join request is void, start again', undefined, events);
    }
    return reject('wrong_code', `wrong code (${ctx.settings.pairingMaxAttempts - attempts} attempts left)`, undefined, events);
  }
  const agentId = ctx.ids.next('agent') as AgentId;
  const projectId = request.projectId;
  const { name, client, tags, capabilities, publicKey, fingerprint } = request;
  return accept(
    [
      ...cancelTimers(model, ctx, SYSTEM, forRequest(request.requestId)),
      makeEvent(ctx, HUB, SYSTEM, 'agent.paired', { agentId, requestId: request.requestId, projectId, name, client, tags, capabilities, publicKey, fingerprint }),
      makeEvent(ctx, HUB, inProject(projectId), 'roster.joined', { agentId, name, role: 'worker', tags, capabilities, client }),
    ],
    { agentId, projectId, role: 'worker' },
  );
};

export const expirePairing: CommandHandler<{ requestId: PairingId }> = (model, _command, ctx) => {
  const request = model.pairing[_command.input.requestId];
  if (request?.status !== 'pending') return accept([]);
  return accept([makeEvent(ctx, HUB, SYSTEM, 'pairing.expired', { requestId: request.requestId })]);
};

export const expirePairingCode: CommandHandler<{ requestId: PairingId }> = (model, command, ctx) => {
  const request = model.pairing[command.input.requestId];
  if (request?.status !== 'allowed') return accept([]);
  return accept([makeEvent(ctx, HUB, SYSTEM, 'pairing.voided', { requestId: request.requestId, reason: 'code_expired' })]);
};
