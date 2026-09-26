import { z } from 'zod';

/**
 * Provider kinds (ADR-0018): the coding CLIs Round Table can run as agents. A provider is one
 * configured CLI (binary, sign-in, model, instance limit); agents are started from it. A kind can
 * start agents only once its driver passed the S8 check (`driverVerified`); until then it can be
 * configured and detected, and the app says so.
 */
export interface ProviderKindDef {
  kind: string;
  label: string;
  /** The binary on PATH, unless the provider names another. */
  binary: string;
  /** The environment variable the CLI reads an API key from. */
  apiKeyEnv: string;
  /** How to sign in with the CLI's own login (subscription), shown in the app. */
  login: string;
  /** How to install it, shown when it isn't found. */
  install: string;
  driverVerified: boolean;
  /** Model names to offer; any string is accepted. */
  models: readonly string[];
}

export const PROVIDER_KINDS = [
  {
    kind: 'claude-code',
    label: 'Claude Code',
    binary: 'claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    login: 'Run `claude` once on the hub machine and log in.',
    install: 'npm i -g @anthropic-ai/claude-code',
    driverVerified: true,
    models: ['sonnet', 'opus', 'haiku'],
  },
  {
    kind: 'codex',
    label: 'Codex',
    binary: 'codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    login: 'Run `codex login` on the hub machine.',
    install: 'npm i -g @openai/codex',
    driverVerified: false,
    models: [],
  },
  {
    kind: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    login: 'Run `gemini` once on the hub machine and sign in with Google.',
    install: 'npm i -g @google/gemini-cli',
    driverVerified: false,
    models: [],
  },
  {
    kind: 'cursor',
    label: 'Cursor CLI',
    binary: 'cursor-agent',
    apiKeyEnv: 'CURSOR_API_KEY',
    login: 'Run `cursor-agent login` on the hub machine.',
    install: 'curl https://cursor.com/install -fsS | bash',
    driverVerified: false,
    models: [],
  },
  {
    kind: 'opencode',
    label: 'opencode',
    binary: 'opencode',
    apiKeyEnv: 'OPENAI_API_KEY',
    login: 'Run `opencode auth login` on the hub machine.',
    install: 'npm i -g opencode-ai',
    driverVerified: false,
    models: [],
  },
] as const satisfies readonly ProviderKindDef[];

export type ProviderKind = (typeof PROVIDER_KINDS)[number]['kind'];
export const ProviderKind = z.enum(PROVIDER_KINDS.map((k) => k.kind) as [ProviderKind, ...ProviderKind[]]);

export function providerKind(kind: string): ProviderKindDef | undefined {
  return PROVIDER_KINDS.find((k) => k.kind === kind);
}

/** 'cli-login': the CLI's own sign-in on the hub machine. 'api-key': a key the hub keeps and passes as an env var. */
export const ProviderAuth = z.enum(['cli-login', 'api-key']);
export type ProviderAuth = z.infer<typeof ProviderAuth>;

/** What the human sets for a provider. Secrets are never part of it (see `provider.secret`). */
export const ProviderSettings = z.object({
  kind: ProviderKind,
  label: z.string().min(1).max(60),
  /** Absolute path or name on PATH; empty means the kind's binary. */
  command: z.string().max(500).default(''),
  auth: ProviderAuth.default('cli-login'),
  model: z.string().max(100).default(''),
  extraArgs: z.array(z.string().max(200)).max(20).default([]),
  maxInstances: z.number().int().min(1).max(20).default(3),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

/** A driven agent's run state, as the hub's supervisor sees it (operational, not in the log). */
export const RUN_STATUSES = ['starting', 'working', 'idle', 'stopped', 'crashed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
