import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentityKey, type KeyPair } from '@round-table/protocol/crypto';

/** The hub's own Ed25519 key: `<dataDir>/hub-key.json`, 0600. Its fingerprint is the hub id agents pin. */
export function loadOrCreateHubKey(dataDir: string): KeyPair {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'hub-key.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as KeyPair;
  const key = generateIdentityKey();
  writeFileSync(path, JSON.stringify(key, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
