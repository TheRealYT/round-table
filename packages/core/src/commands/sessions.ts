import type { AgentId, ProjectId } from '@round-table/protocol';
import { authorOf, HUB, inProject, makeEvent, SYSTEM } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';
import { cancelTimers, inputField, schedule } from './timers.ts';

/**
 * Sessions and liveness (ADR-0002, ADR-0004). The gateway verifies the signed challenge, then
 * dispatches `session.open`; it dispatches `session.closed` when that connection drops.
 * Liveness is the connection, not tool calls, so a model busy in a long build stays active.
 */

const livenessTimers = (agentId: AgentId) => (c: { name: string; input: unknown }) =>
  (c.name === 'roster.mark_stale' || c.name === 'roster.mark_gone') && inputField(c.input, 'agentId') === agentId;

export const openSession: CommandHandler<{ agentId: AgentId }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  if (!agent) return reject('unknown_agent', 'no agent with that id');
  if (agent.revoked) return reject('revoked', 'this key was revoked; pair again');
  const project = model.projects[agent.projectId];
  const entry = project?.roster[agent.agentId];
  if (!project || !entry) return reject('unknown_agent', 'agent is not on a project roster');
  if (entry.state === 'removed') return reject('removed', 'this agent was removed from the project');
  const epoch = agent.epoch + 1;
  const where = inProject(agent.projectId);
  const events = [
    ...cancelTimers(model, ctx, where, livenessTimers(agent.agentId)),
    makeEvent(ctx, HUB, SYSTEM, 'session.opened', { agentId: agent.agentId, projectId: agent.projectId, epoch }),
  ];
  // Back after the grace period: starts again as a new joiner (F9); its work was already released.
  if (entry.state === 'gone' || entry.state === 'left') {
    const { name, tags, capabilities, client } = entry;
    events.push(makeEvent(ctx, HUB, where, 'roster.joined', { agentId: agent.agentId, name, role: 'worker', tags, capabilities, client }));
  }
  events.push(makeEvent(ctx, HUB, where, 'roster.connected', { agentId: agent.agentId, epoch }));
  const role = entry.state === 'gone' || entry.state === 'left' ? 'worker' : entry.role;
  return accept(events, { epoch, projectId: agent.projectId, role, resumed: entry.state === 'active' || entry.state === 'stale' });
};

export const closeSession: CommandHandler<{ agentId: AgentId; epoch: number }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  const entry = agent && model.projects[agent.projectId]?.roster[agent.agentId];
  // A fenced (older) session closing changes nothing: the newer one is live.
  if (!agent || !entry || !entry.connected || command.input.epoch !== agent.epoch) return accept([]);
  const where = inProject(agent.projectId);
  return accept([
    makeEvent(ctx, HUB, where, 'roster.disconnected', { agentId: agent.agentId, epoch: command.input.epoch }),
    schedule(ctx, where, ctx.now + ctx.settings.staleAfterMs, 'roster.mark_stale', { agentId: agent.agentId }),
  ]);
};

export const markStale: CommandHandler<{ agentId: AgentId }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  const entry = agent && model.projects[agent.projectId]?.roster[agent.agentId];
  if (!agent || !entry || entry.connected || entry.state !== 'active') return accept([]);
  const where = inProject(agent.projectId);
  return accept([
    makeEvent(ctx, HUB, where, 'roster.stale', { agentId: agent.agentId }),
    schedule(ctx, where, ctx.now + ctx.settings.graceMs, 'roster.mark_gone', { agentId: agent.agentId }),
  ]);
};

export const markGone: CommandHandler<{ agentId: AgentId }> = (model, command, ctx) => {
  const agent = model.agents[command.input.agentId];
  const entry = agent && model.projects[agent.projectId]?.roster[agent.agentId];
  if (!agent || !entry || entry.connected || entry.state !== 'stale') return accept([]);
  // F10 cleanup (tasks, locks, requests) joins here in S3/S4.
  return accept([makeEvent(ctx, HUB, inProject(agent.projectId), 'roster.gone', { agentId: agent.agentId })]);
};

export const assignLeader: CommandHandler<{ projectId: ProjectId; agentId: AgentId }> = (model, command, ctx) => {
  const project = model.projects[command.input.projectId];
  const entry = project?.roster[command.input.agentId];
  if (!project || !entry || entry.state !== 'active') return reject('unknown_agent', 'agent is not active on this project');
  const author = authorOf(command.principal);
  const where = inProject(project.projectId);
  const events = [];
  if (project.leaderId && project.leaderId !== entry.agentId) {
    events.push(makeEvent(ctx, author, where, 'roster.role_changed', { agentId: project.leaderId, role: 'worker' }));
  }
  events.push(
    makeEvent(ctx, author, where, 'roster.role_changed', { agentId: entry.agentId, role: 'leader' }),
    makeEvent(ctx, author, SYSTEM, 'leader.assigned', { projectId: project.projectId, agentId: entry.agentId, previous: project.leaderId }),
  );
  return accept(events);
};
