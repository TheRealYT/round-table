import type { Identity } from './identity.ts';
import type { KeyStore, PendingJoin } from './keystore.ts';

/** In-memory KeyStore for tests. */
export class MemoryKeyStore implements KeyStore {
  private readonly items = new Map<string, Identity>();
  private readonly pending = new Map<string, PendingJoin>();
  async load(hubId: string, slot: string): Promise<Identity | undefined> {
    return this.items.get(`${hubId}/${slot}`);
  }
  async save(slot: string, identity: Identity): Promise<void> {
    this.items.set(`${identity.hubId}/${slot}`, identity);
  }
  async remove(hubId: string, slot: string): Promise<void> {
    this.items.delete(`${hubId}/${slot}`);
  }
  async loadPending(hubId: string, slot: string): Promise<PendingJoin | undefined> {
    return this.pending.get(`${hubId}/${slot}`);
  }
  async savePending(slot: string, pending: PendingJoin): Promise<void> {
    this.pending.set(`${pending.request.hubId}/${slot}`, pending);
  }
  async clearPending(hubId: string, slot: string): Promise<void> {
    this.pending.delete(`${hubId}/${slot}`);
  }
}
