#!/usr/bin/env node
// The `rt` command. Subcommands arrive slice by slice (docs/architecture/build-plan.md).

const COMMANDS: Record<string, { slice: string; summary: string }> = {
  'hub start': { slice: 'S1', summary: 'Start the hub on 127.0.0.1 and print the one-time login URL.' },
  'agent install': { slice: 'S1', summary: 'Create a worktree and write MCP config + hooks for a client: --client claude-code --slot A --repo <path>.' },
  'hook': { slice: 'S6', summary: 'Hook adapter entry point, called by the agent client: rt hook pre-tool-use | post-tool-use.' },
  'supervise': { slice: 'S4', summary: 'Restart dead agent sessions (D3).' },
};

function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  rt ${name.padEnd(14)} ${c.summary} [${c.slice}]`);
  return ['Usage:', ...lines].join('\n');
}

const args = process.argv.slice(2);
const match = Object.keys(COMMANDS).find((name) => args.join(' ').startsWith(name));
if (!match) {
  console.log(usage());
  process.exitCode = args.length === 0 ? 0 : 1;
} else {
  console.error(`rt ${match}: not built yet (slice ${COMMANDS[match]?.slice}).`);
  process.exitCode = 1;
}
