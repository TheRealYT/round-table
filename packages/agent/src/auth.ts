import type { AgentId } from '@round-table/protocol';
import {
  challengeMessage,
  challengeResponseMessage,
  generateIdentityKey,
  joinConfirmMessage,
  signMessage,
  verifyMessage,
  type KeyPair,
} from '@round-table/protocol/crypto';
import { HubError, type HubClient } from './hub-client.ts';
import type { Identity } from './identity.ts';

export interface HubInfo {
  hubId: string;
  hubPublicKey: string;
  version: number;
}

export interface JoinRequestResult {
  requestId: string;
  matchPhrase: string;
  hubPublicKey: string;
  hubId: string;
}

/** Step 1 of pairing (spec: Pairing). Returns the key pair to keep until the code arrives. */
export async function requestJoin(
  client: HubClient,
  details: { name: string; client: string; tags?: string[]; capabilities?: string[] },
  key: KeyPair = generateIdentityKey(),
): Promise<{ key: KeyPair; request: JoinRequestResult }> {
  const request = await client.call<JoinRequestResult>('join_request', {
    tags: [],
    capabilities: [],
    ...details,
    publicKey: key.publicKey,
  });
  return { key, request };
}

/** Step 2: the human's one-time code, signed with the new key. Returns the identity to store. */
export async function confirmJoin(client: HubClient, pending: { key: KeyPair; request: JoinRequestResult }, code: string, now: number): Promise<Identity> {
  const signature = signMessage(pending.key.privateKey, joinConfirmMessage(pending.request.requestId, code));
  const out = await client.call<{ agentId: AgentId }>('join_confirm', { requestId: pending.request.requestId, code, signature });
  return {
    agentId: out.agentId,
    privateKey: pending.key.privateKey,
    publicKey: pending.key.publicKey,
    hubPublicKey: pending.request.hubPublicKey,
    hubId: pending.request.hubId,
    createdAt: now,
  };
}

export interface SessionInfo {
  epoch: number;
  projectId: string;
  role: 'worker' | 'leader';
  resumed: boolean;
}

/**
 * Rejoin by challenge-response (spec: Rejoin). Checks the hub's signature against the key pinned
 * at pairing first, so a fake hub can't collect signatures.
 */
export async function authenticate(client: HubClient, identity: Identity): Promise<SessionInfo> {
  const c = await client.call<{ nonce: string; hubId: string; ts: number; hubSignature: string }>('session.challenge', { agentId: identity.agentId });
  const fields = { hubId: c.hubId, agentId: identity.agentId, nonce: c.nonce, ts: c.ts };
  if (c.hubId !== identity.hubId || !verifyMessage(identity.hubPublicKey, challengeMessage(fields), c.hubSignature)) {
    throw new HubError('unauthenticated', 'the hub failed to prove its identity; refusing to rejoin');
  }
  const signature = signMessage(identity.privateKey, challengeResponseMessage(fields));
  const session = await client.call<SessionInfo>('session.prove', { agentId: identity.agentId, nonce: c.nonce, signature });
  client.epoch = session.epoch;
  return session;
}
