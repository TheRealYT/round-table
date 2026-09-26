import type { Identity } from './identity.ts';
import type { KeyStore } from './keystore.ts';

/** In-memory KeyStore for tests. */
export class MemoryKeyStore implements KeyStore {
  private readonly items = new Map<string, Identity>();
  async load(hubId: string, slot: string): Promise<Identity | undefined> {
    return this.items.get(`${hubId}/${slot}`);
  }
  async save(slot: string, identity: Identity): Promise<void> {
    this.items.set(`${identity.hubId}/${slot}`, identity);
  }
  async remove(hubId: string, slot: string): Promise<void> {
    this.items.delete(`${hubId}/${slot}`);
  }
}
