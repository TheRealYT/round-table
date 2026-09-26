import type { Identity } from './identity.ts';

/**
 * Where identities live (ADR-0012). The MVP ships a file store (0600 files under $RT_HOME);
 * an OS keychain backend can replace it without touching anything else.
 */
export interface KeyStore {
  load(hubId: string, slot: string): Promise<Identity | undefined>;
  save(slot: string, identity: Identity): Promise<void>;
  remove(hubId: string, slot: string): Promise<void>;
}
