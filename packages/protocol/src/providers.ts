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
  /** Arguments that make the CLI list its models, one per line (e.g. `agy models`). */
  listModels?: readonly string[];
  /** Reasoning effort levels the CLI takes with `--effort`, lowest first; empty when it has none. */
  efforts: readonly string[];
  /** The CLI follows MCP tools/list_changed, so each agent sees only its role's tools. */
  dynamicTools: boolean;
  /** Environment variables people commonly set for this CLI (endpoints, proxies); offered, not enforced. */
  envHints: readonly string[];
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
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], // claude --help, 2.1.283
    dynamicTools: true, // S0: Claude Code refreshes tools on list_changed
    envHints: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'HTTPS_PROXY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'DISABLE_TELEMETRY'],
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
    efforts: [],
    dynamicTools: false,
    envHints: ['OPENAI_BASE_URL', 'HTTPS_PROXY'],
  },
  {
    // Google's CLI for individual users since the Gemini CLI was discontinued for them (June 2026).
    kind: 'antigravity',
    label: 'Antigravity CLI',
    binary: 'agy',
    apiKeyEnv: 'GEMINI_API_KEY',
    login: 'Run `agy` once on the hub machine and sign in. (An API key also needs `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`.)',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    driverVerified: true, // S8 check 6/6 on agy 1.2.11 (2026-09-26)
    models: [],
    listModels: ['models'],
    efforts: ['low', 'medium', 'high', 'max'], // agy --help, 1.2.11
    dynamicTools: false,
    envHints: ['HTTPS_PROXY'],
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
    efforts: [],
    dynamicTools: false,
    envHints: ['HTTPS_PROXY'],
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
    efforts: [],
    dynamicTools: false,
    envHints: ['OPENAI_BASE_URL', 'HTTPS_PROXY'],
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

/** An environment variable name, as shells accept it. */
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, 'use letters, digits and _, not starting with a digit');

/** What the human sets for a provider. Secrets are never part of it (see `provider.secret`). */
export const ProviderSettings = z.object({
  kind: ProviderKind,
  label: z.string().min(1).max(60),
  /** Absolute path or name on PATH; empty means the kind's binary. */
  command: z.string().max(500).default(''),
  auth: ProviderAuth.default('cli-login'),
  model: z.string().max(100).default(''),
  /** Reasoning effort for every agent from this provider, one of the kind's `efforts`; empty: the CLI's default. */
  effort: z.string().max(20).default(''),
  extraArgs: z.array(z.string().max(200)).max(20).default([]),
  maxInstances: z.number().int().min(1).max(20).default(3),
  /** Extra environment for every agent from this provider, e.g. an API endpoint or a proxy. Stored in the log. */
  env: z.array(z.object({ name: EnvName, value: z.string().max(4000) })).max(30).default([]),
  /** Names of secret variables (tokens): their values go through `provider.secret`, never the log. */
  secretEnv: z.array(EnvName).max(30).default([]),
}).superRefine((s, ctx) => {
  const names = [...s.env.map((e) => e.name), ...s.secretEnv];
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) ctx.addIssue({ code: 'custom', message: `${dup} is set twice`, path: ['env'] });
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

/** A driven agent's run state, as the hub's supervisor sees it (operational, not in the log). */
export const RUN_STATUSES = ['starting', 'working', 'idle', 'stopped', 'crashed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
