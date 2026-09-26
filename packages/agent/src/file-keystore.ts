import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { identityPath } from './identity.ts';
import type { Identity } from './identity.ts';
import type { KeyStore, PendingJoin } from './keystore.ts';

/** The MVP key store (ADR-0012): 0600 JSON files per hub and slot, in 0700 directories. */
export class FileKeyStore implements KeyStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(hubId: string, slot: string): Promise<Identity | undefined> {
    return readOptional<Identity>(identityPath(this.home, hubId, slot));
  }

  save(slot: string, identity: Identity): Promise<void> {
    return writePrivate(identityPath(this.home, identity.hubId, slot), identity);
  }

  async remove(hubId: string, slot: string): Promise<void> {
    await rm(identityPath(this.home, hubId, slot), { force: true });
  }

  loadPending(hubId: string, slot: string): Promise<PendingJoin | undefined> {
    return readOptional<PendingJoin>(pendingPath(this.home, hubId, slot));
  }

  savePending(slot: string, pending: PendingJoin): Promise<void> {
    return writePrivate(pendingPath(this.home, pending.request.hubId, slot), pending);
  }

  async clearPending(hubId: string, slot: string): Promise<void> {
    await rm(pendingPath(this.home, hubId, slot), { force: true });
  }
}

function pendingPath(home: string, hubId: string, slot: string): string {
  return identityPath(home, hubId, slot).replace(/\.json$/, '.pending.json');
}

async function readOptional<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}
