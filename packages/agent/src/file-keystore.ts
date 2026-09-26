import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { identityPath } from './identity.ts';
import type { Identity } from './identity.ts';
import type { KeyStore } from './keystore.ts';

/** The MVP key store (ADR-0012): one 0600 JSON file per hub and slot, in 0700 directories. */
export class FileKeyStore implements KeyStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  async load(hubId: string, slot: string): Promise<Identity | undefined> {
    try {
      return JSON.parse(await readFile(identityPath(this.home, hubId, slot), 'utf8')) as Identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(slot: string, identity: Identity): Promise<void> {
    const path = identityPath(this.home, identity.hubId, slot);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async remove(hubId: string, slot: string): Promise<void> {
    await rm(identityPath(this.home, hubId, slot), { force: true });
  }
}
