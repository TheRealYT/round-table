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
    // agy 1.2.11 (first check run, 2026-09-26): print mode with stream-json works, init reports
    // conversation_id and permission_mode "always-proceed"; resume is --conversation <id>; MCP
    // servers are registered with `agy mcp add` (a user-level setting, removed again at the end).
    verified: null,
    mcp: { name: 'rt-check-board', add: (ctx, name) => [['mcp', 'add', name, '--', ctx.server.command, ...ctx.server.args, ctx.server.env.BOARD_LOG], ['mcp', 'add', name, ctx.server.command, ...ctx.server.args, ctx.server.env.BOARD_LOG]], remove: (name) => ['mcp', 'remove', name], list: ['mcp', 'list'], help: [['mcp', '--help'], ['mcp', 'add', '--help']] },
    flags: (ctx) => ['--output-format', 'stream-json', ...pick(ctx, '--dangerously-skip-permissions')],
    first: (ctx) => [['-p', ctx.prompt, ...RECIPES.antigravity.flags(ctx)]],
    resume: (ctx) => [
      ...(ctx.sessionId && ctx.has('--conversation') ? [['-p', ctx.prompt, ...RECIPES.antigravity.flags(ctx), '--conversation', ctx.sessionId]] : []),
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
// A path (./agy, ~/bin/agy) is made absolute: turns run inside the sample repo.
const bin = values.bin ? (values.bin.includes('/') ? resolve(values.bin) : values.bin) : recipe.bin;

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
// A flag counts when --help mentions it as a whole word: `--resume`, `[--resume <id>]`, `--resume=ID`.
const has = (flag) => new RegExp(`(^|[^\\w-])${flag.replace(/[-]/g, '\\-')}(?![\\w-])`, 'm').test(helpText);

const ctxBase = { work, server, has, ourId: randomUUID() };
for (const [path, content] of Object.entries(recipe.files?.(ctxBase) ?? {})) {
  mkdirSync(join(work, path, '..'), { recursive: true });
  writeFileSync(join(work, path), JSON.stringify(content, null, 2));
  appendFileSync(join(work, '.git', 'info', 'exclude'), `${path}\n`);
}
note(`Round Table CLI check: ${kind} (${bin}, ${version.stdout.trim().split('\n')[0]})`);
note(`sample repo ${work}; report ${out}`);
note(recipe.verified ? `recipe verified: ${recipe.verified}` : 'recipe from the CLI’s docs, not verified yet: this run is the verification');

// CLIs that register MCP servers with a subcommand (e.g. `agy mcp add`): add the stand-in hub for
// this run, check it's listed, and remove it again when the check ends (also on Ctrl+C).
let mcpCleanup = () => {};
if (recipe.mcp) {
  const m = recipe.mcp;
  const lines = [];
  const run = (args) => {
    const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 30_000 });
    lines.push(`$ ${bin} ${args.join(' ')}\n(exit ${r.status})\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    return r;
  };
  for (const args of m.help) run(args);
  run(m.remove(m.name)); // left over from an earlier, interrupted run
  let added = false;
  for (const args of m.add(ctxBase, m.name)) {
    if (run(args).status === 0) {
      added = true;
      break;
    }
  }
  const listed = added && (run(m.list).stdout ?? '').includes(m.name);
  writeFileSync(join(out, 'mcp.txt'), lines.join('\n\n'));
  note(added ? `registered the stand-in hub as MCP server "${m.name}"${listed ? '' : ' (but `mcp list` doesn’t show it)'}; it is removed again at the end` : 'could not register the stand-in hub with the CLI’s `mcp add`; see mcp.txt');
  if (added) mcpCleanup = () => run(m.remove(m.name));
}


// ── running turns ────────────────────────────────────────────────────────────────────
let turnNo = 0;
const results = [];
let sessionId = null;
let current = null;
/** The last thing the running CLI printed, for the report if the run is stopped. */
let lastSeen = 'nothing yet';

// Ctrl+C: stop the CLI and still write the report with what the check saw so far.
process.on('SIGINT', () => {
  note('\nstopped by you (Ctrl+C)');
  if (current) results.push({ name: `stopped in turn ${turnNo}`, pass: false, detail: `the CLI was still running; its last output: ${lastSeen}` });
  current?.kill('SIGKILL');
  finish(130);
});

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
  const stdoutFile = join(out, `turn${n}.stdout.jsonl`);
  const stderrFile = join(out, `turn${n}.stderr.txt`);
  writeFileSync(stdoutFile, '');
  writeFileSync(stderrFile, '');
  note(`  $ ${[bin, ...args].map(shortArg).join(' ')}`);
  note(`  live output: tail -f ${stdoutFile}`);
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    const lines = [];
    let stderr = '';
    let buffer = '';
    let errBuffer = '';
    let interruptedAt = null;
    let lastOutputAt = started;
    let lastSummary = '';
    let quietWarned = false;
    const seenTypes = new Set();
    const at = () => `[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s]`;
    const show = (text) => {
      lastSeen = `${at()} ${text}`;
      if (text === lastSummary) return;
      lastSummary = text;
      console.log(`  ${at()} ${text}`);
    };
    child.stdout.on('data', (d) => {
      lastOutputAt = Date.now();
      appendFileSync(stdoutFile, d);
      buffer += d;
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const l of parts) {
        if (!l.trim()) continue;
        lines.push(l);
        const summary = summarize(l);
        if (summary?.startsWith('~')) {
          if (!seenTypes.has(summary)) {
            seenTypes.add(summary);
            show(`event: ${summary.slice(1)}`);
          }
        } else if (summary) show(summary);
      }
    });
    child.stderr.on('data', (d) => {
      lastOutputAt = Date.now();
      appendFileSync(stderrFile, d);
      stderr += d;
      errBuffer += d;
      const parts = errBuffer.split('\n');
      errBuffer = parts.pop();
      for (const l of parts) if (l.trim()) show(`stderr: ${clip(l, 160)}`);
    });
    // Heartbeat: say what's happening when the CLI is quiet, and what quiet usually means.
    const heartbeat = setInterval(() => {
      const quiet = Math.round((Date.now() - lastOutputAt) / 1000);
      if (quiet < 10) return;
      console.log(`  ${at()} … running, no output for ${quiet} s (gives up at ${TURN_MS / 1000} s; Ctrl+C stops and keeps the report)`);
      if (quiet >= 30 && !quietWarned) {
        quietWarned = true;
        console.log(`         Quiet this long usually means ${bin} is waiting for something it can’t show here: a login, a “trust this folder” question or an approval prompt.`);
        console.log(`         To see it, run the command above yourself in ${work}.`);
      }
    }, 10_000);
    const kill = setTimeout(() => {
      note(`  ${at()} no answer after ${TURN_MS / 1000} s: stopping ${bin}`);
      child.kill('SIGKILL');
    }, TURN_MS);
    const fire = () => {
      if (interruptedAt !== null) return;
      interruptedAt = Date.now();
      note(`  ${at()} sending SIGINT (the interrupt check)`);
      child.kill('SIGINT');
    };
    // Interrupt `interruptAfterMs` after `interruptWhen()` first holds, or at `interruptAtMs` regardless.
    let armed = false;
    const watch = interruptWhen
      ? setInterval(() => {
          if (!armed && interruptWhen()) {
            armed = true;
            show('the hub tool call started; interrupting in 15 s');
            setTimeout(fire, interruptAfterMs);
          }
        }, 250)
      : undefined;
    const interrupt = interruptAtMs ? setTimeout(fire, interruptAtMs) : undefined;
    child.on('close', (code, signal) => {
      clearTimeout(kill);
      clearTimeout(interrupt);
      clearInterval(watch);
      clearInterval(heartbeat);
      current = null;
      if (buffer.trim()) lines.push(buffer);
      note(`  ${at()} exited ${signal ? `by ${signal}` : `with code ${code}`}`);
      const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const id = findSessionId(events);
      if (id) sessionId = id;
      done({ code, signal, ms: Date.now() - started, lines, events, stderr, interruptToExitMs: interruptedAt ? Date.now() - interruptedAt : null });
    });
    child.on('error', (error) => {
      clearTimeout(kill);
      clearInterval(heartbeat);
      current = null;
      note(`  could not start ${bin}: ${error.message}`);
      done({ code: -1, signal: null, ms: 0, lines, events: [], stderr: error.message, interruptToExitMs: null });
    });
  });
}

function clip(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function shortArg(arg) {
  const a = clip(arg, 60);
  return /[\s"'{}$]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

/** One output line as a short progress note: tool calls, text, results. Streaming deltas are skipped. */
function summarize(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return `output: ${clip(line, 160)}`;
  }
  const main = e.type ?? (typeof e.event === 'string' ? e.event : undefined) ?? e.kind ?? e.msg?.type;
  const type = [main, e.subtype ?? (typeof e.event === 'object' ? e.event?.type : undefined)].filter(Boolean).join(':') || 'event';
  if (/delta|stream_event|partial/i.test(type)) return null;
  const tools = [];
  const texts = [];
  const stack = [e];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object') continue;
    if (/tool_use|tool_call|function_call/.test(String(o.type ?? '')) && (o.name || o.tool || o.tool_name || o.toolName)) tools.push(o.name ?? o.tool ?? o.tool_name ?? o.toolName);
    else if ((o.type === 'text' || o.type === 'agent_message' || o.type === 'message') && typeof o.text === 'string') texts.push(o.text);
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
  if (e.type === 'user' || /tool_result/.test(type)) return texts.length ? `tool answered: “${clip(texts.join(' '), 100)}”` : null;
  if (tools.length) return `calls ${tools.join(', ')}`;
  if (texts.length) return `says: “${clip(texts.join(' '), 140)}”`;
  // Bare status events only when they mark a start, an end or an error; the heartbeat covers the rest.
  if (/init|start|result|complete|done|finish|error|fail/i.test(type)) return `${type}${e.is_error ? ' (error)' : ''}`;
  return `~${type}`; // other events: shown the first time each kind appears
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
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  note(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'N/A '}  ${name}: ${detail}`);
};

note('\nturn 1: headless task with a file edit, a commit and a hub tool call …');
const t1 = await turn(`You are testing a Round Table integration. Remember this codeword: ${CODE}. In the current folder, create notes.txt containing the line "one" and commit it with git. Then call the report tool (an MCP tool from the Round Table hub) with the text "task 1 done". Then stop.`, true);
check('1 headless', t1.code === 0 && t1.lines.length > 0, `exit ${t1.code}${t1.signal ? ` (${t1.signal})` : ''} in ${Math.round(t1.ms / 1000)} s, ${t1.lines.length} output lines, ${t1.events.length} of them JSON${t1.code !== 0 && t1.stderr.trim() ? `; stderr: ${t1.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`);
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
const t3 = await turn('Message from the hub: call the fetch_plan MCP tool and wait for its answer, then call the report tool with "plan fetched". Then stop.', false, { interruptWhen: () => reported('fetch_plan started'), interruptAfterMs: 15_000, interruptAtMs: 60_000 });
note('turn 4: continue after the interrupt …');
const t4 = await turn(`Message from the hub: the sleep was cancelled on purpose. Call the report tool with "after interrupt, codeword <the codeword>". Then stop.`, false);
const survived = reported(`after interrupt, codeword ${CODE}`);
const waited = reported('fetch_plan started');
if (t3.reason) check('5 interrupt', false, t3.reason);
else check('5 interrupt', t3.interruptToExitMs !== null && t3.interruptToExitMs < 15_000 && survived, `${!waited ? 'it never called fetch_plan; ' : ''}${t3.interruptToExitMs === null ? 'the turn ended before the interrupt' : `stopped ${Math.round(t3.interruptToExitMs / 100) / 10} s after SIGINT`}; ${survived ? 'the next message ran in the same session' : `the next message did not continue the session (exit ${t4.code})`}`);

// ── report ───────────────────────────────────────────────────────────────────────────
finish(results.some((r) => r.pass === false) ? 1 : 0);

function finish(exitCode) {
  mcpCleanup();
  mcpCleanup = () => {};
  writeFileSync(join(out, 'git-log.txt'), git('log', '--oneline'));
  const table = results.map((r) => `| ${r.name} | ${r.pass === true ? 'pass' : r.pass === false ? 'FAIL' : 'n/a'} | ${String(r.detail).replace(/\|/g, '\\|')} |`).join('\n');
  const report = [
    `# Round Table CLI check: ${kind}`,
    '',
    `- CLI: ${bin} — ${version.stdout.trim().split('\n')[0]}`,
    `- Recipe: ${recipe.verified ? `verified (${recipe.verified})` : 'from the CLI’s docs, first run'}`,
    `- Session id seen: ${sessionId ?? 'none'}`,
    `- Date: ${new Date().toISOString()}${exitCode === 130 ? ' (stopped with Ctrl+C before the end)' : ''}`,
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    table,
    '',
    'Files: version.txt, help.txt, turnN.args.json (the exact command), turnN.stdout.jsonl, turnN.stderr.txt, board.log (hub tool calls), git-log.txt, log.txt (what the check printed).',
    '',
  ];
  writeFileSync(join(out, 'report.md'), report.join('\n'));
  const archive = `${out}.tar.gz`;
  spawnSync('tar', ['czf', archive, '-C', resolve(out, '..'), out.split('/').pop()]);
  const passed = results.filter((r) => r.pass === true).length;
  note(`\n${passed} of ${results.length} checks passed. Report: ${join(out, 'report.md')}`);
  note(existsSync(archive) ? `Send this file back: ${archive}` : `Send the folder back: ${out}`);
  process.exit(exitCode);
}
