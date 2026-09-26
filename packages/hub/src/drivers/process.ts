import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Detection } from './driver.ts';

/**
 * Environment for an agent's CLI: the hub's own, minus anything that ties a child to an outer
 * Claude Code session (S8: a nested `claude` otherwise reports and writes to the parent's session).
 */
export function agentEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || OUTER_SESSION.test(key)) continue;
    env[key] = value;
  }
  // S8: as root, Claude Code refuses to skip permissions unless told it runs in a sandbox.
  if (process.getuid?.() === 0) env.IS_SANDBOX = '1';
  return { ...env, ...extra };
}

const OUTER_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|CHILD_SESSION|SYNC_SESSION_REFS|TEE_SDK_STDOUT|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|WORKER_EPOCH|ENTRYPOINT))$/;

/** Where a command resolves on PATH, or undefined. */
export function which(command: string): string | undefined {
  const candidates = isAbsolute(command) || command.includes('/') ? [command] : (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, command));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** `<command> --version`, with a timeout. */
export function detectBinary(command: string): Promise<Detection> {
  const path = which(command);
  if (!path) return Promise.resolve({ found: false, version: null, path: null, error: `${command} is not on the hub’s PATH` });
  return new Promise((resolve) => {
    const child = spawn(path, ['--version'], { env: agentEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ found: false, version: null, path, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = out.trim().split('\n')[0] ?? '';
      resolve(code === 0 ? { found: true, version, path, error: null } : { found: false, version: null, path, error: version || `exit ${code}` });
    });
  });
}
