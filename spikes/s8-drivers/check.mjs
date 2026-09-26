#!/usr/bin/env node
// S8 check for any coding CLI: can Round Table drive it headless? (ADR-0018)
//
//   node spikes/s8-drivers/check.mjs <claude-code|codex|antigravity|cursor|opencode> [--bin <path>]
//
// Run it where the CLI is installed and logged in (your sandbox). No npm install needed. It makes a
// sample git repo and a stand-in hub (an MCP server with one `report` tool), then checks:
//   1 headless   the CLI answers a prompt with no chat window, ideally as JSON lines
//   2 no-prompts it edits a file and runs git commit without asking for approval
//   3 mcp        it loads the hub's MCP server and calls its tool
//   4 resume     a second prompt continues the same session (it remembers a codeword)
//   5 interrupt  a turn stopped partway leaves the session usable for the next message
//   6 cost       it reports cost or token usage per turn
// Everything it saw is written to a report folder (and a .tar.gz of it) to send back, pass or fail.
// The flags for CLIs other than Claude Code come from their docs; where a CLI's --help lacks a flag,
// the check leaves it out and says so, and the saved --help lets the recipe be corrected.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { bin: { type: 'string' }, 'turn-timeout': { type: 'string' } } });
const HERE = new URL('.', import.meta.url).pathname;
const TURN_MS = Number(values['turn-timeout'] ?? 300) * 1000;

// ── recipes: how each CLI is run headless ──────────────────────────────────────────────
// `ctx` has: prompt, sessionId (ours or the one the CLI reported; may be null), has(flag), work,
// server {command, args, env}. Each returns candidate argument lists, tried in order until one runs.

const mcpJson = (server) => ({ mcpServers: { board: server } });
const pick = (ctx, ...flags) => flags.filter((f) => ctx.has(f)).slice(0, 1);

const RECIPES = {
  'claude-code': {
    bin: 'claude',
    verified: 'S8 2026-09-26, Claude Code 2.1.283',
    base: (ctx) => ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--mcp-config', JSON.stringify(mcpJson(ctx.server)), '--strict-mcp-config'],
    first: (ctx) => [['-p', ctx.prompt, ...RECIPES['claude-code'].base(ctx), '--session-id', ctx.ourId]],
    resume: (ctx) => [['-p', ctx.prompt, ...RECIPES['claude-code'].base(ctx), '--resume', ctx.sessionId ?? ctx.ourId]],
  },
  codex: {
    bin: 'codex',
    verified: null,
    // MCP servers go in as -c overrides (TOML values).
    config: (ctx) => [
      '-c', `mcp_servers.board.command=${JSON.stringify(ctx.server.command)}`,
      '-c', `mcp_servers.board.args=${JSON.stringify(ctx.server.args)}`,
      '-c', `mcp_servers.board.env={ BOARD_LOG = ${JSON.stringify(ctx.server.env.BOARD_LOG)} }`,
    ],
    flags: (ctx) => [...pick(ctx, '--dangerously-bypass-approvals-and-sandbox', '--full-auto'), ...pick(ctx, '--skip-git-repo-check')],
    first: (ctx) => [['exec', '--json', ...RECIPES.codex.flags(ctx), ...RECIPES.codex.config(ctx), ctx.prompt]],
    resume: (ctx) => {
      const target = ctx.sessionId ? [ctx.sessionId] : ['--last'];
      return [
        ['exec', '--json', ...RECIPES.codex.flags(ctx), ...RECIPES.codex.config(ctx), 'resume', ...target, ctx.prompt],
        ['exec', 'resume', ...target, '--json', ...RECIPES.codex.flags(ctx), ...RECIPES.codex.config(ctx), ctx.prompt],
      ];
    },
  },
  antigravity: {
    bin: 'agy',
    verified: null,
    // Where agy reads MCP servers from isn't documented for headless use: pass a flag if --help has
    // one, and also write the usual config files into the folder (kept out of git).
    files: (ctx) => ({ '.gemini/settings.json': mcpJson(ctx.server), 'mcp_config.json': mcpJson(ctx.server) }),
    flags: (ctx) => [
      '--output-format', 'stream-json',
      ...pick(ctx, '--dangerously-skip-permissions', '--auto-approve', '--yolo'),
      ...(ctx.has('--mcp-config') ? ['--mcp-config', join(ctx.work, 'mcp_config.json')] : []),
    ],
    first: (ctx) => [['-p', ctx.prompt, ...RECIPES.antigravity.flags(ctx)]],
    resume: (ctx) => [
      ...(ctx.sessionId && ctx.has('--resume') ? [['-p', ctx.prompt, ...RECIPES.antigravity.flags(ctx), '--resume', ctx.sessionId]] : []),
      ...(ctx.has('--continue') ? [['-p', ctx.prompt, ...RECIPES.antigravity.flags(ctx), '--continue']] : []),
    ],
  },
  cursor: {
    bin: 'cursor-agent',
    verified: null,
    files: (ctx) => ({ '.cursor/mcp.json': mcpJson(ctx.server) }),
    flags: (ctx) => ['--output-format', 'stream-json', ...pick(ctx, '--force'), ...pick(ctx, '--approve-mcps')],
    first: (ctx) => [['-p', ctx.prompt, ...RECIPES.cursor.flags(ctx)]],
    resume: (ctx) => [
      ...(ctx.sessionId ? [['-p', ctx.prompt, ...RECIPES.cursor.flags(ctx), '--resume', ctx.sessionId]] : []),
      ...(ctx.has('--continue') ? [['-p', ctx.prompt, ...RECIPES.cursor.flags(ctx), '--continue']] : []),
    ],
  },
  opencode: {
    bin: 'opencode',
    verified: null,
    files: (ctx) => ({
      'opencode.json': {
        $schema: 'https://opencode.ai/config.json',
        permission: { edit: 'allow', bash: 'allow' },
        mcp: { board: { type: 'local', command: [ctx.server.command, ...ctx.server.args], environment: ctx.server.env, enabled: true } },
      },
    }),
    format: (ctx) => (ctx.has('--format') ? ['--format', 'json'] : []),
    first: (ctx) => [['run', ...RECIPES.opencode.format(ctx), ctx.prompt]],
    resume: (ctx) => [
      ...(ctx.sessionId && ctx.has('--session') ? [['run', ...RECIPES.opencode.format(ctx), '--session', ctx.sessionId, ctx.prompt]] : []),
      ...(ctx.has('--continue') ? [['run', ...RECIPES.opencode.format(ctx), '--continue', ctx.prompt]] : []),
    ],
  },
};

const kind = positionals[0];
const recipe = RECIPES[kind];
if (!recipe) {
  console.error(`usage: node check.mjs <${Object.keys(RECIPES).join('|')}> [--bin <path>] [--turn-timeout <seconds>]`);
  process.exit(2);
}
const bin = values.bin ?? recipe.bin;

// ── setup ────────────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = resolve(`cli-check-${kind}-${stamp}`);
mkdirSync(out, { recursive: true });
const work = join(mkdtempSync(join(tmpdir(), `rt-check-${kind}-`)), 'repo');
mkdirSync(work);
const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'check@round-table.local');
git('config', 'user.name', 'check');
writeFileSync(join(work, 'README.md'), '# sample\n');
git('add', '.');
git('commit', '-qm', 'init');
const boardLog = join(out, 'board.log');
writeFileSync(boardLog, '');
const server = { command: process.execPath, args: [join(HERE, 'board-server.mjs')], env: { BOARD_LOG: boardLog } };

// Run as its own agent: drop anything tying it to an outer Claude Code session; as root, Claude
// Code needs IS_SANDBOX=1 to skip permissions (S8).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|CHILD_SESSION|SYNC_SESSION_REFS|TEE_SDK_STDOUT|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|WORKER_EPOCH|ENTRYPOINT))$/.test(k)));
if (process.getuid?.() === 0) env.IS_SANDBOX = '1';

const note = (line) => {
  console.log(line);
  appendFileSync(join(out, 'log.txt'), `${line}\n`);
};

const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
writeFileSync(join(out, 'version.txt'), `${version.stdout ?? ''}${version.stderr ?? ''}${version.error ? String(version.error) : ''}`);
if (version.error || version.status !== 0) {
  note(`${bin} --version failed: ${version.error?.message ?? version.stderr}. Is ${bin} installed and on PATH? (--bin <path> to point at it)`);
  process.exit(1);
}
const helpText = [spawnSync(bin, ['--help'], { env, encoding: 'utf8', timeout: 30_000 }), ...(kind === 'codex' ? [spawnSync(bin, ['exec', '--help'], { env, encoding: 'utf8', timeout: 30_000 })] : []), ...(kind === 'opencode' ? [spawnSync(bin, ['run', '--help'], { env, encoding: 'utf8', timeout: 30_000 })] : [])]
  .map((r) => `${r.stdout ?? ''}${r.stderr ?? ''}`)
  .join('\n');
writeFileSync(join(out, 'help.txt'), helpText);
const has = (flag) => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}([\\s,=<\\[]|$)`, 'm').test(helpText);

const ctxBase = { work, server, has, ourId: randomUUID() };
for (const [path, content] of Object.entries(recipe.files?.(ctxBase) ?? {})) {
  mkdirSync(join(work, path, '..'), { recursive: true });
  writeFileSync(join(work, path), JSON.stringify(content, null, 2));
  appendFileSync(join(work, '.git', 'info', 'exclude'), `${path}\n`);
}
note(`Round Table CLI check: ${kind} (${bin}, ${version.stdout.trim().split('\n')[0]})`);
note(`sample repo ${work}; report ${out}`);
note(recipe.verified ? `recipe verified: ${recipe.verified}` : 'recipe from the CLI’s docs, not verified yet: this run is the verification');

// ── running turns ────────────────────────────────────────────────────────────────────
let turnNo = 0;
let sessionId = null;

/** One headless turn. Tries each candidate argument list until one exits 0 or produces output. */
async function turn(prompt, first, options = {}) {
  const candidates = (first ? recipe.first : recipe.resume)({ ...ctxBase, prompt, sessionId });
  if (candidates.length === 0) return { ok: false, reason: 'no way to resume: --help shows no resume or continue flag', events: [], lines: [] };
  let result;
  for (const args of candidates) {
    result = await runOnce(args, options);
    if (result.code === 0 || result.lines.length > 0) break;
  }
  return result;
}

function runOnce(args, { interruptWhen, interruptAfterMs, interruptAtMs } = {}) {
  const n = ++turnNo;
  writeFileSync(join(out, `turn${n}.args.json`), JSON.stringify([bin, ...args], null, 2));
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let stderr = '';
    let buffer = '';
    let interruptedAt = null;
    child.stdout.on('data', (d) => {
      buffer += d;
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const l of parts) if (l.trim()) lines.push(l);
    });
    child.stderr.on('data', (d) => (stderr += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), TURN_MS);
    const fire = () => {
      if (interruptedAt !== null) return;
      interruptedAt = Date.now();
      child.kill('SIGINT');
    };
    // Interrupt `interruptAfterMs` after `interruptWhen()` first holds, or at `interruptAtMs` regardless.
    let armed = false;
    const watch = interruptWhen
      ? setInterval(() => {
          if (!armed && interruptWhen()) {
            armed = true;
            setTimeout(fire, interruptAfterMs);
          }
        }, 250)
      : undefined;
    const interrupt = interruptAtMs ? setTimeout(fire, interruptAtMs) : undefined;
    child.on('close', (code, signal) => {
      clearTimeout(kill);
      clearTimeout(interrupt);
      clearInterval(watch);
      if (buffer.trim()) lines.push(buffer);
      writeFileSync(join(out, `turn${n}.stdout.jsonl`), lines.join('\n'));
      writeFileSync(join(out, `turn${n}.stderr.txt`), stderr);
      const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const id = findSessionId(events);
      if (id) sessionId = id;
      done({ code, signal, ms: Date.now() - started, lines, events, stderr, interruptToExitMs: interruptedAt ? Date.now() - interruptedAt : null });
    });
    child.on('error', (error) => {
      clearTimeout(kill);
      done({ code: -1, signal: null, ms: 0, lines, events: [], stderr: error.message, interruptToExitMs: null });
    });
  });
}

/** The CLI's session id, whatever it calls it. */
function findSessionId(events) {
  const keys = /^(session_?id|sessionId|thread_?id|threadId|conversation_?id|conversationId|chat_?id|chatId)$/;
  for (const e of events) {
    const stack = [e];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      for (const [k, v] of Object.entries(o)) {
        if (keys.test(k) && typeof v === 'string' && v.length >= 6) return v;
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

/** Numbers under keys about cost or tokens, anywhere in the events. */
function usage(events) {
  const found = {};
  for (const e of events) {
    const stack = [[e, '']];
    while (stack.length) {
      const [o, path] = stack.pop();
      if (!o || typeof o !== 'object') continue;
      for (const [k, v] of Object.entries(o)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof v === 'number' && /cost|usd|token/i.test(k)) found[p] = v;
        else if (v && typeof v === 'object') stack.push([v, p]);
      }
    }
  }
  return found;
}

const commits = () => Number(git('rev-list', '--count', 'HEAD')) - 1;
const reported = (needle) => reports().some((r) => r.includes(needle));
function reports() {
  return readFileSync(boardLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
}

// ── the checks ───────────────────────────────────────────────────────────────────────
const CODE = `PELICAN-${Math.floor(Math.random() * 900 + 100)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  note(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'N/A '}  ${name}: ${detail}`);
};

note('\nturn 1: headless task with a file edit, a commit and a hub tool call …');
const t1 = await turn(`You are testing a Round Table integration. Remember this codeword: ${CODE}. In the current folder, create notes.txt containing the line "one" and commit it with git. Then call the report tool (from the "board" MCP server) with the text "task 1 done". Then stop.`, true);
check('1 headless', t1.code === 0 && t1.lines.length > 0, `exit ${t1.code}${t1.signal ? ` (${t1.signal})` : ''} in ${Math.round(t1.ms / 1000)} s, ${t1.lines.length} output lines, ${t1.events.length} of them JSON${t1.code !== 0 ? `; stderr: ${t1.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`);
check('2 no-prompts', commits() >= 1, commits() >= 1 ? `it committed on its own (${git('log', '-1', '--format=%s')})` : 'no commit: it may have asked for approval, or lacks a flag to skip it (see turn1 output)');
check('3 mcp', reported('task 1 done'), reported('task 1 done') ? 'it called the hub’s report tool' : 'the report tool was never called: the CLI did not load the MCP server, or needs its config elsewhere (see help.txt for "mcp")');
const cost = usage(t1.events);
const costKeys = Object.keys(cost).sort((a, b) => Number(/token/i.test(a)) - Number(/token/i.test(b)));
check('6 cost', costKeys.length > 0 ? true : null, costKeys.length > 0 ? costKeys.slice(0, 6).map((k) => `${k}=${cost[k]}`).join(', ') : 'no cost or token fields in its output');
note(`session id: ${sessionId ?? 'not found in the output'}`);

note('\nturn 2: resume the session …');
const t2 = await turn(`Message from the hub: append the line "two" to notes.txt and commit. Then call the report tool with "task 2 done, codeword <the codeword I gave you earlier>". Then stop.`, false);
check('4 resume', reported(`task 2 done, codeword ${CODE}`), reported(`task 2 done, codeword ${CODE}`) ? `same session, codeword remembered (${Math.round(t2.ms / 1000)} s)` : t2.reason ?? `exit ${t2.code}; the report was ${reports().filter((r) => r.startsWith('task 2')).join(' | ') || 'missing'}`);

note('\nturn 3: a slow hub call, interrupted while the CLI waits for it …');
// A slow MCP tool, not a shell sleep: models may push a sleep into the background, but they have to
// wait for a tool call. The CLI is interrupted 15 s after the call starts (or at 60 s).
const t3 = await turn('Message from the hub: call the fetch_plan tool (from the "board" MCP server) and wait for its answer, then call the report tool with "plan fetched". Then stop.', false, { interruptWhen: () => reported('fetch_plan started'), interruptAfterMs: 15_000, interruptAtMs: 60_000 });
note('turn 4: continue after the interrupt …');
const t4 = await turn(`Message from the hub: the sleep was cancelled on purpose. Call the report tool with "after interrupt, codeword <the codeword>". Then stop.`, false);
const survived = reported(`after interrupt, codeword ${CODE}`);
const waited = reported('fetch_plan started');
check('5 interrupt', t3.interruptToExitMs !== null && t3.interruptToExitMs < 15_000 && survived, `${!waited ? 'it never called fetch_plan; ' : ''}${t3.interruptToExitMs === null ? 'the turn ended before the interrupt' : `stopped ${Math.round(t3.interruptToExitMs / 100) / 10} s after SIGINT`}; ${survived ? 'the next message ran in the same session' : `the next message did not continue the session (exit ${t4.code})`}`);

// ── report ───────────────────────────────────────────────────────────────────────────
writeFileSync(join(out, 'git-log.txt'), git('log', '--oneline'));
const table = results.map((r) => `| ${r.name} | ${r.pass === true ? 'pass' : r.pass === false ? 'FAIL' : 'n/a'} | ${String(r.detail).replace(/\|/g, '\\|')} |`).join('\n');
writeFileSync(join(out, 'report.md'), `# Round Table CLI check: ${kind}

- CLI: ${bin} — ${version.stdout.trim().split('\n')[0]}
- Recipe: ${recipe.verified ? `verified (${recipe.verified})` : 'from the CLI’s docs, first run'}
- Session id seen: ${sessionId ?? 'none'}
- Date: ${new Date().toISOString()}

| Check | Result | Detail |
|---|---|---|
${table}

Files: version.txt, help.txt, turnN.args.json (the exact command), turnN.stdout.jsonl, turnN.stderr.txt, board.log (hub tool calls), git-log.txt.
`);
const archive = `${out}.tar.gz`;
spawnSync('tar', ['czf', archive, '-C', resolve(out, '..'), out.split('/').pop()]);
const passed = results.filter((r) => r.pass === true).length;
note(`\n${passed} of ${results.length} checks passed. Report: ${join(out, 'report.md')}`);
note(existsSync(archive) ? `Send this file back: ${archive}` : `Send the folder back: ${out}`);
process.exit(results.some((r) => r.pass === false) ? 1 : 0);
