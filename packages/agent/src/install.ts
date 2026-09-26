import { assertSlot } from './identity.ts';
import { clientProfile, type ClientProfile } from './clients.ts';

export interface InstallOptions {
  client: string;
  dir: string;
  /** Fixed identity for this config (one folder, one agent). Omit to identify agents by their join name. */
  slot?: string;
  hubUrl: string;
  /** How to start the rt command: `[node, /path/to/cli/src/main.ts]`. */
  command: [string, ...string[]];
  /** Extra environment for rt-agent (e.g. a custom RT_HOME); MCP clients may not pass theirs through. */
  env?: Record<string, string>;
}

/**
 * `rt agent install` (ADR-0014): writes the client's per-project MCP config so that client starts
 * rt-agent for this slot. Existing config is merged, not replaced.
 */
export function installAgent(options: InstallOptions): { profile: ClientProfile; files: string[]; notes: string[] } {
  if (options.slot !== undefined) assertSlot(options.slot);
  const profile = clientProfile(options.client);
  const [command, ...prefix] = options.command;
  const server = {
    command,
    args: [...prefix, 'agent', 'run', ...(options.slot !== undefined ? ['--slot', options.slot] : []), '--hub', options.hubUrl, '--client', profile.id],
    ...(options.env && Object.keys(options.env).length > 0 && { env: options.env }),
  };
  return { profile, ...profile.install(options.dir, server) };
}
