/**
 * A driver runs one kind of coding CLI headless (ADR-0018). The supervisor owns the loop; the
 * driver only starts the process, feeds it messages and reports what it does in one shape.
 */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DriverStart {
  /** Which agent this is (drivers that register per-agent resources name them after it). */
  agentId: string;
  agentName: string;
  /** The binary (empty: the kind's default). */
  command: string;
  cwd: string;
  /** Extra environment, e.g. the provider's API key. */
  env: Record<string, string>;
  /** rt-agent in driven mode: the agent's Round Table tools. */
  mcp: McpServerSpec;
  /** Added to the CLI's own system prompt. */
  systemPrompt: string;
  model: string;
  extraArgs: string[];
  /** Resume this CLI session (after a crash or a hub restart); null starts a new one. */
  resumeSessionId: string | null;
}

export type DriverEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  /** The model's reasoning, when the CLI shows it (empty text: it thought, but the CLI hides the content). */
  | { type: 'thinking'; text: string; tokens?: number }
  /** A tool call; `id` pairs it with its result. `input` is the full JSON (capped). */
  | { type: 'tool'; id?: string; name: string; input: string }
  | { type: 'tool_result'; id?: string; output: string; isError: boolean }
  | {
      type: 'turn_end';
      ok: boolean;
      durationMs: number;
      /** The CLI's cumulative cost for the session, if it reports one. */
      sessionCostUsd: number | null;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
    }
  | { type: 'exit'; code: number | null; error: string | null };

export interface AgentProcess {
  /** A user turn: a message from the hub. */
  send(text: string): void;
  /** Stop the current turn; the process stays up for the next message. */
  interrupt(): void;
  /** End the process. */
  stop(): void;
}

export interface Detection {
  found: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

export interface Driver {
  detect(command: string): Promise<Detection>;
  start(options: DriverStart, onEvent: (event: DriverEvent) => void): AgentProcess;
  /** One tiny prompt, to check the sign-in works. */
  test(options: { command: string; env: Record<string, string>; model: string }): Promise<{ ok: boolean; message: string; ms: number; costUsd: number | null }>;
}
