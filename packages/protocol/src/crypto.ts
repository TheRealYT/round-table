import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/**
 * Identity crypto shared by hub and rt-agent (Node only; import `@round-table/protocol/crypto`).
 * Ed25519 keys. Public keys travel as base64 SPKI DER; private keys stay in PKCS8 PEM on disk.
 * Every signed message starts with a domain tag, so a signature can't be replayed in another context.
 */
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateIdentityKey(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Human-comparable fingerprint shown in the app, e.g. `SHA256:3xQ…` (first 16 chars). */
export function fingerprint(publicKey: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url').slice(0, 16)}`;
}

export function signMessage(privateKey: string, message: string): string {
  return sign(null, Buffer.from(message), createPrivateKey(privateKey)).toString('base64');
}

export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** What the agent signs to finish pairing: proves it holds the key it registered. */
export function joinConfirmMessage(requestId: string, code: string): string {
  return `round-table/join-confirm\n${requestId}\n${normalizeCode(code)}`;
}

/** What the hub signs when it issues a rejoin challenge (the agent checks it against the pinned hub key). */
export function challengeMessage(c: { hubId: string; agentId: string; nonce: string; ts: number }): string {
  return `round-table/challenge\n${c.hubId}\n${c.agentId}\n${c.nonce}\n${c.ts}`;
}

/** What the agent signs to answer a challenge. */
export function challengeResponseMessage(c: { hubId: string; agentId: string; nonce: string; ts: number }): string {
  return `round-table/challenge-response\n${c.hubId}\n${c.agentId}\n${c.nonce}\n${c.ts}`;
}

// Crockford base32 without I, L, O, U: easy to read and type.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** One-time pairing code: 8 characters, about 40 bits. */
export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

/** Codes are stored only as hashes, never in the log. */
export function hashPairingCode(code: string): string {
  return createHash('sha256').update(`round-table/code\n${normalizeCode(code)}`).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
