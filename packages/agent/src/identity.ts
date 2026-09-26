import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentId } from '@round-table/protocol';

/** What rt-agent keeps per identity slot (ADR-0003). The model never sees any of it. */
export interface Identity {
  agentId: AgentId;
  /** Ed25519 private key, pkcs8 PEM. */
  privateKey: string;
  publicKey: string;
  /** Pinned at pairing; rejoin challenges must be signed by this key (fake-hub protection). */
  hubPublicKey: string;
  hubId: string;
  createdAt: number;
  /**
   * Named mode (ADR-0017): sha-256 of the token held by the chat the human approved for this agent.
   * Only the hash is stored, so the token can't be read from disk.
   */
  chatTokenHash?: string;
}

/** `$RT_HOME`, defaulting to the XDG config dir. */
export function rtHome(env: Record<string, string | undefined> = process.env): string {
  if (env.RT_HOME) return env.RT_HOME;
  const config = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(config, 'round-table');
}

const SLOT = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertSlot(slot: string): string {
  if (!SLOT.test(slot)) throw new Error(`invalid slot "${slot}": use 1-32 chars of a-z, 0-9 and "-"`);
  return slot;
}

export function identityPath(home: string, hubId: string, slot: string): string {
  return join(home, 'identities', hubId, `${assertSlot(slot)}.json`);
}

/** Unix socket the hook adapter uses to reach this slot's rt-agent (architecture §8). */
export function hookSocketPath(home: string, slot: string): string {
  return join(home, 'run', `${assertSlot(slot)}.sock`);
}
