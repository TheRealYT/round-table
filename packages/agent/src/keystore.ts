import type { KeyPair } from '@round-table/protocol/crypto';
import type { Identity } from './identity.ts';

/** A join request waiting for the human's code. Persisted so an rt-agent restart mid-pairing loses nothing. */
export interface PendingJoin {
  key: KeyPair;
  request: { requestId: string; matchPhrase: string; hubPublicKey: string; hubId: string };
}

/**
 * Where identities live (ADR-0012). The MVP ships a file store (0600 files under $RT_HOME);
 * an OS keychain backend can replace it without touching anything else.
 */
export interface KeyStore {
  load(hubId: string, slot: string): Promise<Identity | undefined>;
  save(slot: string, identity: Identity): Promise<void>;
  remove(hubId: string, slot: string): Promise<void>;
  loadPending(hubId: string, slot: string): Promise<PendingJoin | undefined>;
  savePending(slot: string, pending: PendingJoin): Promise<void>;
  clearPending(hubId: string, slot: string): Promise<void>;
  /** Slots with a pending join request for this hub (to finish pairing after a restart). */
  listPending(hubId: string): Promise<string[]>;
}
