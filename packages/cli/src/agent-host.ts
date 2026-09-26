import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentWorktree, FileKeyStore } from '@round-table/agent';
import type { AgentHost } from '@round-table/hub';

/** The slot a hub-run agent's identity is stored under, in its own RT_HOME. */
const SLOT = 'agent';

/**
 * Where hub-run agents live (ADR-0018): `<data>/agents/<agentId>/` holds the agent's own RT_HOME
 * (its identity, 0600) and its working folder, a git worktree of the project's repository when the
 * project has one. rt-agent runs in driven mode with that RT_HOME.
 */
export class FolderAgentHost implements AgentHost {
  private readonly dataDir: string;
  private readonly hubUrl: string | (() => string);
  private readonly rtAgent: string[];

  /** `hubUrl` may be a function when the port is known only after the hub listens. */
  constructor(options: { dataDir: string; hubUrl: string | (() => string); rtAgent: string[] }) {
    this.dataDir = options.dataDir;
    this.hubUrl = options.hubUrl;
    this.rtAgent = options.rtAgent;
  }

  async provision(agent: Parameters<AgentHost['provision']>[0]): Promise<void> {
    await new FileKeyStore(this.home(agent.agentId)).save(SLOT, {
      agentId: agent.agentId as never,
      privateKey: agent.key.privateKey,
      publicKey: agent.key.publicKey,
      hubPublicKey: agent.hubPublicKey,
      hubId: agent.hubId,
      createdAt: Date.now(),
    });
  }

  async prepare(agent: Parameters<AgentHost['prepare']>[0]) {
    const cwd = join(this.dataDir, 'agents', agent.agentId, 'work');
    if (agent.repo) createAgentWorktree(agent.repo.path, cwd, agent.repo.mainBranch);
    else if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    const [command, ...args] = this.rtAgent;
    return {
      cwd,
      mcp: {
        command: command!,
        args: [...args, 'agent', 'run', '--slot', SLOT, '--hub', typeof this.hubUrl === 'string' ? this.hubUrl : this.hubUrl(), '--driven'],
        env: { RT_HOME: this.home(agent.agentId) },
      },
    };
  }

  private home(agentId: string): string {
    return join(this.dataDir, 'agents', agentId, 'home');
  }
}
