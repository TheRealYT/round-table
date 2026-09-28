import { nextStep, rulesBrief, settingsFor, type Model, type ProviderRecord, type TurnTrigger } from '@round-table/core';
import { providerKind, type AgentId, type EventRow, type MessageEnvelope, type Principal, type ProjectId, type RunStatus } from '@round-table/protocol';
import type { KeyPair } from '@round-table/protocol/crypto';
import type { Bus } from './command-bus.ts';
import type { AgentProcess, Driver, DriverEvent, McpServerSpec } from './drivers/driver.ts';
import { ackDeliveries, pendingDeliveries } from './projectors/deliveries.ts';
import type { SecretStore } from './secrets.ts';
import type { SqliteEventStore } from './sqlite-store.ts';

const HUB: Principal = { kind: 'hub', component: 'supervisor' };
/** Steps kept per agent in the transcript table; older ones are pruned. */
const TRANSCRIPT_KEEP = 5_000;
/** Ask the same next step at most this often before leaving the agent idle for the human. */
const SAME_STEP_MAX = 2;

/**
 * Workspace preparation for hub-run agents, implemented by `cli` with the agent package (the hub
 * doesn't depend on it): the identity file, the git worktree, and how to start rt-agent.
 */
export interface AgentHost {
  /** Once, when the agent is created: store its identity where its rt-agent will look. */
  provision(agent: { agentId: string; name: string; hubId: string; hubPublicKey: string; key: KeyPair }): Promise<void>;
  /** Before each start: the folder it works in and its MCP server. */
  prepare(agent: { agentId: string; name: string; repo: { path: string; mainBranch: string } | null }): Promise<{ cwd: string; mcp: McpServerSpec }>;
}

/** Where a provider credential lives in the secret store: the API key, or a secret env var. */
export function secretKey(providerId: string, name: string | null): string {
  return name ? `${providerId}:${name}` : providerId;
}

/**
 * The environment an agent from this provider gets: the provider's variables, its secret ones,
 * then the API key (which wins, since the human chose that sign-in). Throws when a value is missing.
 */
export function providerEnv(provider: ProviderRecord, secrets: SecretStore): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { name, value } of provider.settings.env ?? []) env[name] = value;
  for (const name of provider.settings.secretEnv ?? []) {
    const value = secrets.get(secretKey(provider.providerId, name));
    if (value === undefined) throw new Error(`no value is set for the secret variable ${name}`);
    env[name] = value;
  }
  if (provider.settings.auth === 'api-key') {
    const kind = providerKind(provider.settings.kind);
    const key = secrets.get(secretKey(provider.providerId, null));
    if (!key || !kind) throw new Error(`no API key is set for ${provider.settings.label}`);
    env[kind.apiKeyEnv] = key;
  }
  return env;
}

/**
 * One step of a hub-run agent's session, as the CLI reported it: what the hub told it, its thinking,
 * each tool call and result, its text, and turn boundaries. Kept in the hub database (not the event
 * log: it is operational and large), so the human can read the whole session, also after restarts.
 */
export interface TranscriptEntry {
  id: number;
  at: number;
  kind: 'to_agent' | 'thinking' | 'text' | 'tool' | 'tool_result' | 'turn' | 'status';
  text: string;
  data: Record<string, unknown> | null;
}

export interface LiveState {
  status: RunStatus;
  since: number;
  lastError: string | null;
  /** The tool the agent is using now, if any. */
  tool: string | null;
}

interface Live extends LiveState {
  proc: AgentProcess | undefined;
  /** Deliveries in the current turn, acked when it ends. */
  handed: number[];
  turnStartedAt: number;
  lastStep: string | null;
  sameStep: number;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on each start, so events from an old process are ignored. */
  generation: number;
  /** Hub notices for the next turn (e.g. a role change), ahead of messages. */
  notices: string[];
  /** What the messages taken for the next turn were, for the turn's trigger (insights). */
  taken: TurnTrigger | null;
  /** Its model or effort changed mid-turn: restart once the turn ends. */
  restartAfterTurn: boolean;
}

export interface SupervisorOptions {
  model: Model;
  bus: Bus;
  store: SqliteEventStore;
  secrets: SecretStore;
  host: AgentHost;
  drivers: Partial<Record<string, Driver>>;
  now: () => number;
  maxChars: number;
  restartDelaysMs: number[];
  /** How long to gather a burst of agent messages into one turn. */
  coalesceMs: number;
  log?: (message: string) => void;
}

/**
 * Runs the agents the human started from providers (ADR-0018). It follows each agent's wished run
 * state, starts its CLI through a driver, and owns the loop: a turn per batch of messages, a nudge
 * when the board gives an idle agent work, acks at the end of each turn, and restarts with backoff.
 */
export class Supervisor {
  private readonly o: SupervisorOptions;
  private readonly live = new Map<string, Live>();
  private pumpQueued = false;
  private pumpDelayed: ReturnType<typeof setTimeout> | undefined;
  /** Identities being stored for new agents; their first start waits for it. */
  private readonly provisions = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: SupervisorOptions) {
    this.o = options;
    const sql = options.store.reader;
    sql.run(`CREATE TABLE IF NOT EXISTS agent_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      data TEXT
    )`);
    sql.run('CREATE INDEX IF NOT EXISTS agent_steps_by_agent ON agent_steps (agent_id, id)');
  }

  /** After a hub restart: start every agent the human left running. */
  resumeAll(): void {
    for (const agent of Object.values(this.o.model.agents)) if (agent.driven?.run) this.reconcile(agent.agentId);
  }

  onCommit(rows: EventRow[]): void {
    for (const row of rows) {
      if (row.type === 'agent.run_requested') this.reconcile((row.payload as { agentId: string }).agentId, true);
      if (row.type === 'agent.configured') this.restartWhenIdle((row.payload as { agentId: string }).agentId);
      if (row.type === 'settings.changed') this.noticeRulesChange();
      if (row.type === 'roster.role_changed') {
        const { agentId, role } = row.payload as { agentId: string; role: string };
        const live = this.live.get(agentId);
        if (live) live.notices.push(`[Round Table] Your role changed: you are now the ${role}. ${roleBrief(role)}`);
      }
    }
    // Agent messages often come in bursts (a request, then a note): wait a moment so they make one
    // turn. The human never waits.
    const burst = rows.some((r) => r.type === 'message.sent') && !rows.some((r) => r.type === 'human.posted');
    this.queuePump(burst ? this.o.coalesceMs : 0);
  }

  /** The router stores a new agent's identity; the agent starts once it is written. */
  provisioning(agentId: string, done: Promise<void>): Promise<void> {
    const tracked = done.finally(() => this.provisions.delete(agentId));
    this.provisions.set(agentId, tracked);
    return tracked;
  }

  state(agentId: string): LiveState | null {
    const live = this.live.get(agentId);
    if (!live) return this.o.model.agents[agentId as AgentId]?.driven ? { status: 'stopped', since: 0, lastError: null, tool: null } : null;
    return { status: live.status, since: live.since, lastError: live.lastError, tool: live.tool };
  }

  /** Steps after `after` (oldest first); with no `after`, the latest `limit` steps. */
  transcript(agentId: string, after = 0, limit = 500): TranscriptEntry[] {
    const sql = this.o.store.reader;
    const rows = after > 0
      ? sql.all<{ id: number; at: number; kind: string; text: string; data: string | null }>('SELECT * FROM agent_steps WHERE agent_id = ? AND id > ? ORDER BY id LIMIT ?', [agentId, after, limit])
      : sql.all<{ id: number; at: number; kind: string; text: string; data: string | null }>('SELECT * FROM (SELECT * FROM agent_steps WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', [agentId, limit]);
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind as TranscriptEntry['kind'], text: r.text, data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null }));
  }

  interrupt(agentId: string): boolean {
    const live = this.live.get(agentId);
    if (!live?.proc || live.status !== 'working') return false;
    live.proc.interrupt();
    this.note(agentId, 'status', 'interrupted by the human');
    return true;
  }

  /** Stop every process (hub shutdown); wished states stay as they are for the next start. */
  close(): void {
    this.closed = true;
    clearTimeout(this.pumpDelayed);
    for (const live of this.live.values()) {
      clearTimeout(live.restartTimer);
      live.generation += 1;
      live.proc?.stop();
      live.proc = undefined;
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────

  private reconcile(agentId: string, requested = false): void {
    const agent = this.o.model.agents[agentId as AgentId];
    if (!agent?.driven || this.closed) return;
    const live = this.entry(agentId);
    if (!agent.driven.run) {
      clearTimeout(live.restartTimer);
      if (live.proc) {
        live.generation += 1;
        live.proc.stop();
        live.proc = undefined;
      }
      this.setStatus(live, 'stopped');
      return;
    }
    if (requested) live.restarts = 0; // the human asked: start fresh, forget earlier crashes
    if (!live.proc && live.status !== 'starting') void this.start(agentId);
  }

  /** Rules in settings changed: each running agent hears its new rules with its next turn. */
  private lastRules = new Map<string, string>();
  private noticeRulesChange(): void {
    for (const [agentId, live] of this.live) {
      const agent = this.o.model.agents[agentId as AgentId];
      const role = agent ? this.o.model.projects[agent.projectId]?.roster[agent.agentId]?.role : undefined;
      if (!agent || !live.proc) continue;
      const rules = rulesBrief(this.o.model, agent.projectId, role === 'leader' ? 'leader' : 'worker');
      if (rules === (this.lastRules.get(agentId) ?? rules)) {
        this.lastRules.set(agentId, rules);
        continue;
      }
      this.lastRules.set(agentId, rules);
      live.notices.push(`[Round Table] The human changed the rules. You now work under:\n${rules || '(no rules)'}`);
    }
  }

  /** New model or effort: restart the CLI (it resumes its conversation) now if idle, else after this turn. */
  private restartWhenIdle(agentId: string): void {
    const live = this.live.get(agentId);
    if (!live?.proc) return;
    if (live.status !== 'idle') {
      live.restartAfterTurn = true;
      return;
    }
    live.restartAfterTurn = false;
    live.generation += 1;
    live.proc.stop();
    live.proc = undefined;
    this.note(agentId, 'status', 'restarting with its new model or effort');
    void this.start(agentId);
  }

  private entry(agentId: string): Live {
    let live = this.live.get(agentId);
    if (!live) {
      live = { status: 'stopped', since: this.o.now(), lastError: null, tool: null, proc: undefined, handed: [], turnStartedAt: 0, lastStep: null, sameStep: 0, restarts: 0, restartTimer: undefined, generation: 0, notices: [], taken: null, restartAfterTurn: false };
      this.live.set(agentId, live);
    }
    return live;
  }

  private async start(agentId: string): Promise<void> {
    const live = this.entry(agentId);
    const generation = ++live.generation;
    this.setStatus(live, 'starting');
    try {
      await null; // the router registers a new agent's identity write right after dispatch
      await this.provisions.get(agentId);
      const agent = this.o.model.agents[agentId as AgentId]!;
      const driven = agent.driven!;
      const provider = this.o.model.providers[driven.providerId];
      if (!provider || provider.removed) throw new Error('its provider was removed');
      const kind = providerKind(provider.settings.kind);
      const driver = this.o.drivers[provider.settings.kind];
      if (!driver || !kind?.driverVerified) throw new Error(`Round Table can’t run ${kind?.label ?? provider.settings.kind} yet`);
      const env = providerEnv(provider, this.o.secrets);
      const project = this.o.model.projects[agent.projectId];
      const repo = project?.repoId ? this.o.model.repos[project.repoId] : undefined;
      const prepared = await this.o.host.prepare({ agentId, name: agent.name, repo: repo ? { path: repo.path, mainBranch: repo.mainBranch } : null });
      // A CLI that follows tools/list_changed gets only its role's tools: fewer tokens every turn.
      const workspace = kind.dynamicTools ? { ...prepared, mcp: { ...prepared.mcp, args: [...prepared.mcp.args, '--tools', 'dynamic'] } } : prepared;
      if (generation !== live.generation || this.closed) return;
      const resumed = driven.cliSessionId !== null;
      const agents = settingsFor(this.o.model, agent.projectId).agents;
      const roleDefaults = project?.roster[agent.agentId]?.role === 'leader' ? { model: agents.leaderModel, effort: agents.leaderEffort } : { model: agents.workerModel, effort: agents.workerEffort };
      live.proc = driver.start(
        {
          agentId,
          agentName: agent.name,
          command: provider.settings.command,
          cwd: workspace.cwd,
          env,
          mcp: workspace.mcp,
          systemPrompt: systemPrompt(agent.name),
          // The agent's own choice, else its role's default from settings, else the provider's.
          model: driven.model || roleDefaults.model || provider.settings.model,
          effort: driven.effort || (kind.efforts.includes(roleDefaults.effort) ? roleDefaults.effort : '') || provider.settings.effort,
          extraArgs: provider.settings.extraArgs,
          resumeSessionId: driven.cliSessionId,
        },
        (event) => {
          if (generation === live.generation) this.onEvent(agentId, live, event);
        },
      );
      live.lastError = null;
      live.lastStep = null;
      live.sameStep = 0;
      this.note(agentId, 'status', resumed ? 'started (resuming its conversation)' : 'started');
      this.sendTurn(agentId, live, this.kickoff(agentId, resumed), 'kickoff');
    } catch (error) {
      if (generation !== live.generation) return;
      live.proc = undefined;
      live.lastError = error instanceof Error ? error.message : String(error);
      this.note(agentId, 'status', `could not start: ${live.lastError}`);
      this.setStatus(live, 'crashed');
    }
  }

  private onEvent(agentId: string, live: Live, event: DriverEvent): void {
    switch (event.type) {
      case 'session':
        this.o.bus.dispatch('agent.cli_session', { agentId, cliSessionId: event.sessionId }, HUB);
        return;
      case 'text':
        this.note(agentId, 'text', event.text);
        return;
      case 'thinking':
        this.note(agentId, 'thinking', event.text, event.tokens === undefined ? null : { tokens: event.tokens });
        return;
      case 'tool':
        live.tool = event.name;
        this.note(agentId, 'tool', event.name, { id: event.id ?? null, name: event.name, input: event.input });
        return;
      case 'tool_result':
        this.note(agentId, 'tool_result', event.output, { id: event.id ?? null, isError: event.isError });
        return;
      case 'turn_end': {
        const driven = this.o.model.agents[agentId as AgentId]?.driven;
        const before = driven?.sessionCostUsd ?? 0;
        const costUsd = event.sessionCostUsd === null ? null : Math.max(0, event.sessionCostUsd - before);
        ackDeliveries(this.o.store.reader, agentId, live.handed, this.o.now());
        live.handed = [];
        live.tool = null;
        if (event.ok) live.restarts = 0;
        live.lastError = event.error;
        this.o.bus.dispatch('agent.turn', { agentId, ok: event.ok, durationMs: event.durationMs, costUsd, sessionCostUsd: event.sessionCostUsd, inputTokens: event.inputTokens, outputTokens: event.outputTokens, error: event.error }, HUB);
        this.note(agentId, 'turn', `${event.ok ? 'turn done' : `turn ended: ${event.error}`} (${Math.round(event.durationMs / 1000)} s${costUsd === null ? '' : `, $${costUsd.toFixed(3)}`})`, { ok: event.ok, durationMs: event.durationMs, costUsd, tokens: event.inputTokens + event.outputTokens, error: event.error });
        this.setStatus(live, 'idle');
        if (live.restartAfterTurn) this.restartWhenIdle(agentId);
        else this.queuePump();
        return;
      }
      case 'exit': {
        live.proc = undefined;
        live.tool = null;
        live.handed = []; // unacked: the hub delivers them again
        const wanted = this.o.model.agents[agentId as AgentId]?.driven?.run ?? false;
        if (!wanted || this.closed) {
          this.setStatus(live, 'stopped');
          return;
        }
        live.lastError = event.error ?? `the process exited (code ${event.code})`;
        this.note(agentId, 'status', `exited: ${live.lastError}`);
        this.setStatus(live, 'crashed');
        const delay = this.o.restartDelaysMs[live.restarts];
        if (delay === undefined) {
          this.note(agentId, 'status', 'crashed too often: start it again from the app');
          return;
        }
        live.restarts += 1;
        live.restartTimer = setTimeout(() => this.reconcile(agentId), delay);
        live.restartTimer.unref?.();
        return;
      }
    }
  }

  // ── the loop ───────────────────────────────────────────────────────────────────────────

  private queuePump(delayMs = 0): void {
    if (this.closed) return;
    if (this.pumpQueued) {
      // A pump is already coming; an urgent one moves it forward.
      if (delayMs > 0 || this.pumpDelayed === undefined) return;
      clearTimeout(this.pumpDelayed);
      this.pumpDelayed = undefined;
    }
    this.pumpQueued = true;
    const run = () => {
      this.pumpQueued = false;
      this.pumpDelayed = undefined;
      for (const [agentId, live] of this.live) if (live.status === 'idle' && live.proc) this.pump(agentId, live);
    };
    if (delayMs > 0) {
      this.pumpDelayed = setTimeout(run, delayMs);
      this.pumpDelayed.unref?.();
    } else setImmediate(run);
  }

  /** An idle agent: hand it its messages, or the next step the board gives it. */
  private pump(agentId: string, live: Live): void {
    const agent = this.o.model.agents[agentId as AgentId];
    if (!agent) return;
    const step = nextStep(this.o.model, agent.projectId, agent.agentId);
    // Only messages that ask something of this agent wake it (human, critical, direct). Normal and
    // digest ones (broadcasts, FYIs) ride along with its next turn, so they cost no turn of their own.
    if (live.notices.length === 0 && !this.hasWaking(agentId) && !this.wantsStep(live, step)) return;
    const notices = live.notices.splice(0);
    const taken = this.takeMessages(agentId, live);
    const messages = [...notices, taken].filter(Boolean).join('\n') || undefined;
    if (messages) {
      // Messages, then what the board wants next, so the turn ends with a clear step.
      live.lastStep = step.tool === 'wait' ? null : step.step;
      live.sameStep = step.tool === 'wait' ? 0 : 1;
      this.sendTurn(agentId, live, `${messages}\n\n${nextLine(step)}`, taken ? (live.taken ?? 'agent') : 'notice');
      return;
    }
    if (step.tool === 'wait') {
      live.lastStep = null;
      return;
    }
    if (step.step === live.lastStep) {
      if (live.sameStep >= SAME_STEP_MAX) return; // it isn't moving; the human sees it idle
      live.sameStep += 1;
    } else {
      live.lastStep = step.step;
      live.sameStep = 1;
    }
    this.sendTurn(agentId, live, `[Round Table] next: ${step.step}`, 'nudge');
  }

  private hasWaking(agentId: string): boolean {
    return (this.o.store.reader.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked_at IS NULL AND priority IN ('human', 'critical', 'direct')", [agentId])?.n ?? 0) > 0;
  }

  /** The board has a step for this agent that it hasn't been asked too often already. */
  private wantsStep(live: Live, step: { tool: string; step: string }): boolean {
    return step.tool !== 'wait' && !(step.step === live.lastStep && live.sameStep >= SAME_STEP_MAX);
  }

  private kickoff(agentId: string, resumed: boolean): string {
    const agent = this.o.model.agents[agentId as AgentId]!;
    const project = this.o.model.projects[agent.projectId];
    const role = project?.roster[agent.agentId]?.role ?? 'worker';
    const goal = Object.values(project?.entries ?? {}).find((e) => e.section === 'goal')?.data as { objective?: string } | undefined;
    const step = nextStep(this.o.model, agent.projectId, agent.agentId);
    const live = this.entry(agentId);
    live.notices = []; // the kickoff states the current role
    const messages = this.takeMessages(agentId, live);
    const lines = resumed
      ? [`[Round Table] The Round Table restarted you. You are still ${agent.name}, the ${role}, on project "${project?.name ?? agent.projectId}". Carry on from where you were.`]
      : [
          `[Round Table] You are ${agent.name}, the ${role} on project "${project?.name ?? agent.projectId}". ${roleBrief(role)}`,
          `Goal: ${goal?.objective ?? 'not set yet (the human sets it in the app)'}.`,
        ];
    const rules = project ? rulesBrief(this.o.model, project.projectId, role === 'leader' ? 'leader' : 'worker') : '';
    if (rules && !resumed) lines.push(`[Round Table] Rules you work under:\n${rules}`);
    this.lastRules.set(agentId, rules);
    if (messages) lines.push(messages);
    if (step.tool !== 'wait') {
      live.lastStep = step.step;
      live.sameStep = 1;
    }
    lines.push(nextLine(step));
    return lines.join('\n\n');
  }

  /** Pending deliveries as one turn's text, marked handed (acked when the turn ends). */
  private takeMessages(agentId: string, live: Live): string | undefined {
    const { items, more } = pendingDeliveries(this.o.store.reader, agentId, this.o.maxChars);
    if (items.length === 0) return undefined;
    live.handed = items.map((d) => d.deliveryId);
    live.taken = strongest(items.map((d) => d.message));
    const agent = this.o.model.agents[agentId as AgentId];
    const project = agent ? this.o.model.projects[agent.projectId as ProjectId] : undefined;
    const who = (m: MessageEnvelope) => (m.role === 'human' ? 'the human' : m.role === 'hub' ? 'the hub' : (project?.roster[m.from as AgentId]?.name ?? m.from));
    const lines = items.map(({ message: m }) => `[Round Table] ${m.priority === 'human' || m.priority === 'critical' ? `${m.priority.toUpperCase()} ` : ''}message from ${who(m)} (${m.type}${m.ref ? `, about ${m.ref}` : ''}): ${m.body}`);
    if (items.some((d) => d.message.role === 'human')) lines.push('[Round Table] The human’s messages outrank the board: do what they ask first.');
    if (more > 0) lines.push(`[Round Table] ${more} more message(s) follow after this turn.`);
    return lines.join('\n');
  }

  private sendTurn(agentId: string, live: Live, text: string, trigger: TurnTrigger): void {
    if (!live.proc) return;
    live.turnStartedAt = this.o.now();
    live.taken = null;
    this.note(agentId, 'to_agent', text, { trigger });
    this.setStatus(live, 'working');
    live.proc.send(text);
    void agentId;
  }

  private setStatus(live: Live, status: RunStatus): void {
    if (live.status !== status) {
      live.status = status;
      live.since = this.o.now();
    }
  }

  private written = 0;

  private note(agentId: string, kind: TranscriptEntry['kind'], text: string, data: Record<string, unknown> | null = null): void {
    const sql = this.o.store.reader;
    sql.run('INSERT INTO agent_steps (agent_id, at, kind, text, data) VALUES (?, ?, ?, ?, ?)', [agentId, this.o.now(), kind, text, data ? JSON.stringify(data) : null]);
    if (++this.written % 200 === 0) {
      sql.run('DELETE FROM agent_steps WHERE agent_id = ? AND id <= (SELECT id FROM agent_steps WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', [agentId, agentId, TRANSCRIPT_KEEP]);
    }
  }
}

function nextLine(step: { tool: string; step: string }): string {
  if (step.tool !== 'wait') return `[Round Table] next: ${step.step}`;
  // Hub-run agents don't call wait: keep why they are waiting, then tell them to end the turn.
  const why = step.step.replace(/\s*Call wait\b.*$/s, '').trim();
  return `[Round Table] next: ${why && !/^Nothing needs you/.test(why) ? `${why} ` : 'nothing else needs you right now. '}End your turn when done; you are woken when something arrives.`;
}

function roleBrief(role: string): string {
  return role === 'leader'
    ? 'As the leader you plan and coordinate: you turn the goal into a plan of small tasks that touch different files, commit it in one board_commit, review proposals, answer questions with send, and keep the team moving. You never write code, review or test.'
    : 'As a worker you claim ready tasks (the leader plans them), implement them in this folder (your git worktree) on the task’s branch, open change requests, get another worker to review and test them, and review or test others’ work when asked. You never approve your own work.';
}

function systemPrompt(name: string): string {
  return `You are ${name}, an AI agent on a Round Table team: several AI agents and a human, coordinated by a hub, working toward one goal.
The Round Table runs this session. Messages from the hub, the human and other agents arrive as user turns whose lines start with "[Round Table]". Act on them through the roundtable MCP tools (board, tasks, messages, requests) and in the current folder, which is your own git worktree.
When nothing needs you, end your turn: the Round Table wakes you when something arrives. Never wait, poll or sleep for messages, and don't call the wait tool.
The human's messages outrank everything. Talk to the team only through Round Table tools; the human reads the board and messages in the Round Table app.`;
}

/** What woke an agent, from the messages it was handed: the most urgent sender wins. */
function strongest(messages: MessageEnvelope[]): TurnTrigger {
  if (messages.some((m) => m.role === 'human' || m.priority === 'human')) return 'human';
  if (messages.some((m) => m.priority === 'critical')) return 'critical';
  if (messages.some((m) => m.role !== 'hub' && m.to !== 'all')) return 'agent';
  if (messages.some((m) => m.role === 'hub' && m.type === 'request')) return 'request';
  if (messages.some((m) => m.role === 'hub' && m.type === 'response')) return 'response';
  if (messages.some((m) => m.role === 'hub')) return 'hub';
  return 'broadcast';
}
