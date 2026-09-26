// S8 spike: can Round Table drive Claude Code headless, instead of hoping a chat keeps calling wait?
// Q1 resume the same session per wake-up, Q2 structured output, Q3 no prompts inside a worktree,
// Q4 one long-lived process fed messages on stdin, Q5 interrupt mid-turn and carry on, Q6 MCP tools.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const here = new URL('.', import.meta.url).pathname;
const repo = mkdtempSync(join(tmpdir(), 's8-repo-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 'agent');
writeFileSync(join(repo, 'README.md'), '# sample\n'); git('add', '.'); git('commit', '-qm', 'init');
const boardLog = join(repo, '..', `board-${Date.now()}.log`);
const mcp = join(repo, '..', `mcp-${Date.now()}.json`);
writeFileSync(mcp, JSON.stringify({ mcpServers: { board: { command: process.execPath, args: [join(here, 'board.mjs')], env: { BOARD_LOG: boardLog } } } }));
const base = ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--mcp-config', mcp, '--strict-mcp-config'];
const reports = () => (existsSync(boardLog) ? readFileSync(boardLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
const out = {};
// Run as a separate agent: not part of any Claude Code session this script runs under. IS_SANDBOX=1:
// Claude Code refuses bypassPermissions as root otherwise (finding: a root sandbox must set it).
const SESSION_VARS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SYNC_SESSION_REFS', 'CLAUDE_CODE_TEE_SDK_STDOUT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_WORKER_EPOCH'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.includes(k)));
env.IS_SANDBOX = '1';

/** One headless turn: returns the parsed events. */
function turn(args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn('claude', ['-p', ...args, ...base], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const events = []; let err = '';
    createInterface({ input: p.stdout }).on('line', (l) => { try { events.push(JSON.parse(l)); } catch {} });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve({ events, ms: Date.now() - t0 }) : reject(new Error(`exit ${code}: ${err.slice(0, 400)}`))));
  });
}
const resultOf = (events) => events.find((e) => e.type === 'result');
const toolsUsed = (events) => events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use').map((c) => c.name));

// ── Q1–Q3, Q6: one session, resumed per wake-up ──
const sid = randomUUID();
const wakes = [];
const first = await turn(['--session-id', sid, 'You are a worker agent driven by the Round Table hub. The codeword is PELICAN; remember it. Task: create notes.txt containing "one", commit it with git, then call the report tool with "task 1 done". Then end your turn.']);
wakes.push(first);
for (let i = 2; i <= 4; i++) {
  wakes.push(await turn(['--resume', sid, `Message from the hub (wake-up ${i}): append the line "${['', '', 'two', 'three', 'four'][i]}" to notes.txt, commit, and call report with "task ${i} done, codeword <the codeword>". Then end your turn.`]));
}
out.resume = wakes.map((w) => {
  const r = resultOf(w.events);
  return { ms: w.ms, session: r?.session_id, turns: r?.num_turns, costUsd: r?.total_cost_usd, inTokens: r?.usage?.input_tokens, cacheRead: r?.usage?.cache_read_input_tokens, outTokens: r?.usage?.output_tokens, tools: toolsUsed(w.events), permissionDenials: r?.permission_denials?.length ?? 0 };
});
out.gitLog = git('log', '--oneline');
out.notes = readFileSync(join(repo, 'notes.txt'), 'utf8');
out.reportsAfterResume = reports();
out.eventTypes = [...new Set(wakes[0].events.map((e) => `${e.type}${e.subtype ? ':' + e.subtype : ''}`))];
out.initTools = wakes[0].events.find((e) => e.subtype === 'init')?.tools?.filter((t) => t.startsWith('mcp__'));

// ── Q4, Q5: one long-lived process, messages pushed on stdin ──
const sid2 = randomUUID();
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--session-id', sid2, ...base], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
const live = []; let waiters = [];
createInterface({ input: p.stdout }).on('line', (l) => { try { const e = JSON.parse(l); live.push(e); waiters = waiters.filter((w) => !w(e)); } catch {} });
let exited = null; p.on('close', (c) => (exited = c));
const send = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
const next = (pred, ms = 180_000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); waiters.push((e) => (pred(e) ? (clearTimeout(t), res(e), true) : false)); });
const live1 = Date.now();
send('You are a worker agent driven by the Round Table hub. The codeword is HERON. Call report with "live 1". Then end your turn.');
const r1 = await next((e) => e.type === 'result');
await new Promise((r) => setTimeout(r, 20_000)); // idle: no message for 20 s
const aliveAfterIdle = exited === null;
send('Message from the hub: call report with "live 2, codeword <the codeword>". Then end your turn.');
const r2 = await next((e) => e.type === 'result');
// Q5: interrupt a long turn, then carry on in the same process.
send('Message from the hub: run the shell command `sleep 90` and then call report with "slept".');
await next((e) => e.type === 'assistant' && e.message.content.some((c) => c.type === 'tool_use'));
const tInt = Date.now();
p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n');
const afterInterrupt = await next((e) => e.type === 'result' || (e.type === 'control_response'), 60_000).catch((e) => ({ error: String(e) }));
const r3 = afterInterrupt.type === 'result' ? afterInterrupt : await next((e) => e.type === 'result', 60_000).catch((e) => ({ error: String(e) }));
const interruptMs = Date.now() - tInt;
send('Message from the hub: the sleep was cancelled on purpose. Call report with "after interrupt, codeword <the codeword>". Then end your turn.');
const r4 = await next((e) => e.type === 'result').catch((e) => ({ error: String(e) }));
p.stdin.end();
await new Promise((r) => setTimeout(r, 3000));
out.live = {
  firstResultMs: r1 && Date.now() - live1,
  aliveAfter20sIdle: aliveAfterIdle,
  results: [r1, r2, r3, r4].map((r) => ({ subtype: r.subtype, isError: r.is_error, session: r.session_id, turns: r.num_turns, cost: r.total_cost_usd, error: r.error })),
  interruptAck: afterInterrupt.type === 'control_response' ? afterInterrupt.response?.subtype : afterInterrupt.type,
  interruptToResultMs: interruptMs,
  exitAfterStdinEnd: exited,
};
out.reportsAll = reports();
console.log(JSON.stringify(out, null, 2));
