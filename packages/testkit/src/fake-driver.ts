import type { AgentHost, AgentProcess, Driver, DriverEvent, DriverStart } from '@round-table/hub';

/** One started process of the fake driver: what the supervisor sent it, and a way to act as the CLI. */
export class FakeProcess implements AgentProcess {
  readonly options: DriverStart;
  readonly sent: string[] = [];
  interrupts = 0;
  stopped = false;
  private readonly emitTo: (event: DriverEvent) => void;

  constructor(options: DriverStart, emit: (event: DriverEvent) => void) {
    this.options = options;
    this.emitTo = emit;
  }

  send(text: string): void {
    this.sent.push(text);
  }
  interrupt(): void {
    this.interrupts += 1;
  }
  stop(): void {
    this.stopped = true;
    this.emit({ type: 'exit', code: 0, error: null });
  }

  emit(event: DriverEvent): void {
    this.emitTo(event);
  }

  /** The CLI finished its turn. */
  endTurn(options: { ok?: boolean; sessionCostUsd?: number | null; error?: string } = {}): void {
    this.emit({ type: 'turn_end', ok: options.ok ?? true, durationMs: 1000, sessionCostUsd: options.sessionCostUsd ?? null, inputTokens: 100, outputTokens: 10, error: options.error ?? null });
  }

  get last(): string {
    return this.sent.at(-1) ?? '';
  }
}

/** A driver whose "CLI" the test plays: every start is recorded as a FakeProcess. */
export class FakeDriver implements Driver {
  readonly started: FakeProcess[] = [];
  version = 'fake 1.0';

  async detect() {
    return { found: true, version: this.version, path: '/usr/bin/fake', error: null };
  }

  start(options: DriverStart, onEvent: (event: DriverEvent) => void): AgentProcess {
    const proc = new FakeProcess(options, onEvent);
    this.started.push(proc);
    return proc;
  }

  async test() {
    return { ok: true, message: 'Signed in and answering.', ms: 5, costUsd: 0.001 };
  }

  /** The latest process started for a folder (the fake host names folders after agent ids). */
  of(agentId: string): FakeProcess | undefined {
    return this.started.filter((p) => p.options.cwd.endsWith(agentId)).at(-1);
  }
}

/** Records provisioned identities and hands out fake folders. */
export class FakeAgentHost implements AgentHost {
  readonly provisioned: Array<{ agentId: string; name: string }> = [];
  async provision(agent: Parameters<AgentHost['provision']>[0]): Promise<void> {
    this.provisioned.push({ agentId: agent.agentId, name: agent.name });
  }
  async prepare(agent: Parameters<AgentHost['prepare']>[0]) {
    return { cwd: `/fake/work/${agent.agentId}`, mcp: { command: 'rt', args: ['agent', 'run', '--driven'], env: {} } };
  }
}
