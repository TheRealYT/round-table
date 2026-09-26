import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Provider credentials (ADR-0018). Kept outside the event log, so exports, snapshots and the app
 * never contain them; the log only records that one was set. Nothing reads a value back except the
 * supervisor, which passes it to the agent's process as an environment variable.
 */
export interface SecretStore {
  get(providerId: string): string | undefined;
  set(providerId: string, value: string): void;
  delete(providerId: string): void;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  get(providerId: string): string | undefined {
    return this.values.get(providerId);
  }
  set(providerId: string, value: string): void {
    this.values.set(providerId, value);
  }
  delete(providerId: string): void {
    this.values.delete(providerId);
  }
}

/** A 0600 JSON file next to the hub's database (ADR-0012: same-user processes are out of scope). */
export class FileSecretStore implements SecretStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  get(providerId: string): string | undefined {
    return this.read()[providerId];
  }
  set(providerId: string, value: string): void {
    this.write({ ...this.read(), [providerId]: value });
  }
  delete(providerId: string): void {
    const { [providerId]: _gone, ...rest } = this.read();
    this.write(rest);
  }
  private read(): Record<string, string> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>) : {};
  }
  private write(values: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
