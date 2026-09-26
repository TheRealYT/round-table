import type { CommandHandler } from '../module.ts';
import { send, humanPost, reportActivity } from './messaging.ts';
import { allowPairing, blockOrigin, denyPairing, expirePairing, expirePairingCode, joinConfirm, joinRequest } from './pairing.ts';
import { createProject } from './projects.ts';
import { commit, humanEdit, propose, rejectTicket } from './board.ts';
import { mergeResult, openRequest, respond } from './changes.ts';
import { attachRepo } from './repos.ts';
import { markProviderSecret, recordCliSession, recordTurn, removeProvider, saveProvider, setAgentRun, spawnAgent } from './drivers.ts';
import { approvePlan, claim, release } from './tasks.ts';
import { assignLeader, closeSession, markGone, markStale, openSession } from './sessions.ts';

/**
 * Every command core can decide, by name. Names that are also procedures in the catalog are
 * reachable by agents or the human (the router checks `allow` first); the others are internal
 * and only the hub (gateway, scheduler, reactors) dispatches them.
 */
export const COMMANDS: Record<string, CommandHandler> = {
  'project.create': createProject,
  join_request: joinRequest,
  join_confirm: joinConfirm,
  'pairing.allow': allowPairing,
  'pairing.deny': denyPairing,
  'pairing.block_origin': blockOrigin,
  'leader.assign': assignLeader,
  send,
  'human.post': humanPost,
  activity: reportActivity,
  'repo.attach': attachRepo,
  'goal.set': humanEdit('goal', 'goal'),
  'rules.edit': humanEdit('rules', 'rules'),
  'plan.approve': approvePlan,
  board_propose: propose,
  board_commit: commit,
  board_reject: rejectTicket,
  claim,
  release,
  request: openRequest,
  respond,
  'provider.save': saveProvider,
  'provider.remove': removeProvider,
  'agent.spawn': spawnAgent,
  'agent.run': setAgentRun,
  // internal: router (credentials) and supervisor
  'provider.secret_mark': markProviderSecret,
  'agent.cli_session': recordCliSession,
  'agent.turn': recordTurn,
  // internal: merge reactor
  'merge.result': mergeResult,
  // internal: gateway
  'session.open': openSession,
  'session.closed': closeSession,
  // internal: scheduler
  'pairing.expire': expirePairing,
  'pairing.code_expire': expirePairingCode,
  'roster.mark_stale': markStale,
  'roster.mark_gone': markGone,
};

export const INTERNAL_COMMANDS = new Set([
  'provider.secret_mark',
  'agent.cli_session',
  'agent.turn',
  'merge.result',
  'session.open',
  'session.closed',
  'pairing.expire',
  'pairing.code_expire',
  'roster.mark_stale',
  'roster.mark_gone',
]);
