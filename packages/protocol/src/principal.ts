import type { AgentId, ProjectId } from './ids.ts';

/**
 * Who is calling. The gateway derives it from the connection and its authentication;
 * it is never taken from frame contents (spec: the hub stamps sender ids and roles).
 *
 * - unpaired: an /agent connection that has not proven a key yet (can only pair or rejoin)
 * - worker / leader: an authenticated agent session, bound to one project
 * - human: an /app session with a valid login cookie
 * - hub: internal commands (timers, reactors, git watcher); never reachable from a socket
 */
export type PrincipalKind = 'unpaired' | 'worker' | 'leader' | 'human' | 'hub';

export type Principal =
  | { kind: 'unpaired'; origin: string }
  | { kind: 'worker' | 'leader'; agentId: AgentId; projectId: ProjectId; epoch: number }
  | { kind: 'human'; humanId: string }
  | { kind: 'hub'; component: string };

export const AGENT_KINDS = ['worker', 'leader'] as const satisfies readonly PrincipalKind[];
