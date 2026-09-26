import { providerKind, type AgentId, type ProjectId, type ProviderId, type ProviderSettings } from '@round-table/protocol';
import { authorOf, HUB, inProject, makeEvent, SYSTEM } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';
import type { Model } from '../model.ts';

/**
 * Providers and hub-run agents (ADR-0018). The hub prepares what needs IO or crypto before these
 * run: the agent's key pair (only the public half arrives here) and stored credentials.
 */

export const saveProvider: CommandHandler<{ providerId?: ProviderId; settings: ProviderSettings }> = (model, command, ctx) => {
  const { providerId: given, settings } = command.input;
  if (given !== undefined) {
    const existing = model.providers[given];
    if (!existing || existing.removed) return reject('unknown_provider', 'no such provider');
    if (existing.settings.kind !== settings.kind) return reject('invalid_input', 'a provider’s kind can’t change; add a new provider');
  }
  const providerId = given ?? (ctx.ids.next('provider') as ProviderId);
  return accept([makeEvent(ctx, authorOf(command.principal), SYSTEM, 'provider.saved', { providerId, settings })], { providerId });
};

export const removeProvider: CommandHandler<{ providerId: ProviderId }> = (model, command, ctx) => {
  const provider = model.providers[command.input.providerId];
  if (!provider || provider.removed) return reject('unknown_provider', 'no such provider');
  const running = runningFrom(model, provider.providerId);
  if (running > 0) return reject('in_use', `${running} agent(s) from this provider are running; stop them first`);
  return accept([makeEvent(ctx, authorOf(command.principal), SYSTEM, 'provider.removed', { providerId: provider.providerId })]);
};

/** Internal: the hub stored or cleared a credential. */
export const markProviderSecret: CommandHandler<{ providerId: ProviderId; set: boolean }> = (model, command, ctx) => {
  const provider = model.providers[command.input.providerId];
  if (!provider || provider.removed) return reject('unknown_provider', 'no such provider');
  return accept([makeEvent(ctx, HUB, SYSTEM, 'provider.secret_changed', command.input)]);
};

export const spawnAgent: CommandHandler<{
  projectId: ProjectId;
  providerId: ProviderId;
  name: string;
  tags: string[];
  publicKey: string;
  fingerprint: string;
}> = (model, command, ctx) => {
  const { projectId, providerId, name, tags, publicKey, fingerprint } = command.input;
  const project = model.projects[projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const provider = model.providers[providerId];
  if (!provider || provider.removed) return reject('unknown_provider', 'no such provider');
  const kind = providerKind(provider.settings.kind);
  if (!kind?.driverVerified) {
    return reject('driver_unverified', `${kind?.label ?? provider.settings.kind} can be configured, but Round Table can’t run it yet: its driver hasn’t passed the check`);
  }
  if (provider.settings.auth === 'api-key' && !provider.hasSecret) return reject('no_credential', 'this provider signs in with an API key, and none is set');
  const running = runningFrom(model, providerId);
  if (running >= provider.settings.maxInstances) {
    return reject('instance_limit', `${provider.settings.label} already runs ${running} of ${provider.settings.maxInstances} agents; stop one or raise the limit`);
  }
  const taken = Object.values(project.roster).some((r) => r.name.toLowerCase() === name.toLowerCase() && r.state !== 'removed' && r.state !== 'left');
  if (taken) return reject('name_taken', `an agent named ${name} is already in this project`);
  const agentId = ctx.ids.next('agent') as AgentId;
  const author = authorOf(command.principal);
  return accept(
    [
      makeEvent(ctx, author, SYSTEM, 'agent.provisioned', { agentId, projectId, providerId, name, tags, publicKey, fingerprint }),
      makeEvent(ctx, author, inProject(projectId), 'roster.joined', { agentId, name, role: 'worker', tags, capabilities: [], client: provider.settings.kind }),
      makeEvent(ctx, author, SYSTEM, 'agent.run_requested', { agentId, run: true }),
    ],
    { agentId },
  );
};

export const setAgentRun: CommandHandler<{ projectId: ProjectId; agentId: AgentId; run: boolean }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  if (!agent?.driven || agent.projectId !== command.input.projectId) return reject('unknown_agent', 'no agent the hub runs with that id in this project');
  if (!command.input.run && !agent.driven.run) return accept([]);
  // Starting again is always recorded: it also restarts an agent that crashed too often.
  if (command.input.run && !agent.driven.run) {
    const provider = model.providers[agent.driven.providerId];
    if (!provider || provider.removed) return reject('unknown_provider', 'its provider was removed');
    const running = runningFrom(model, provider.providerId);
    if (running >= provider.settings.maxInstances) return reject('instance_limit', `${provider.settings.label} already runs ${running} of ${provider.settings.maxInstances} agents`);
  }
  return accept([makeEvent(ctx, authorOf(command.principal), SYSTEM, 'agent.run_requested', { agentId: agent.agentId, run: command.input.run })]);
};

/** Internal (supervisor): the CLI reported its session id. */
export const recordCliSession: CommandHandler<{ agentId: AgentId; cliSessionId: string }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  if (!agent?.driven) return reject('unknown_agent', 'not a hub-run agent');
  if (agent.driven.cliSessionId === command.input.cliSessionId) return accept([]);
  return accept([makeEvent(ctx, HUB, SYSTEM, 'agent.cli_session', command.input)]);
};

/** Internal (supervisor): one turn ended, with what the CLI reported. */
export const recordTurn: CommandHandler<{ agentId: AgentId; ok: boolean; durationMs: number; costUsd: number | null; sessionCostUsd: number | null; inputTokens: number; outputTokens: number; error: string | null }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  if (!agent?.driven) return reject('unknown_agent', 'not a hub-run agent');
  return accept([makeEvent(ctx, HUB, inProject(agent.projectId), 'agent.turn_finished', command.input)]);
};

function runningFrom(model: Readonly<Model>, providerId: ProviderId): number {
  return Object.values(model.agents).filter((a) => a.driven?.providerId === providerId && a.driven.run && !a.revoked).length;
}
