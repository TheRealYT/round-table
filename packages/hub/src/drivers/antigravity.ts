import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess, Driver, DriverEvent, DriverStart } from './driver.ts';
import { agentEnv, detectBinary } from './process.ts';

/**
 * Antigravity CLI (`agy`), from the S8 check on agy 1.2.11 (6 of 6): one `agy -p` process per
 * message with `--output-format stream-json --dangerously-skip-permissions`, continued with
 * `--conversation <id>`; SIGINT stops a turn and the next one continues the conversation.
 *
 * MCP servers are user-level (`agy mcp add`), so each agent's rt-agent is registered under its own
 * name while the agent runs and removed when it stops. Every agy session on the machine can see
 * every registered server; the prompt names the agent's own (see FINDINGS: agents of one OS user
 * could already read each other's files, ADR-0012). agy has no system-prompt flag, so the
 * Round Table instructions open the first message of a new conversation.
 */
export class AntigravityDriver implements Driver {
  detect(command: string) {
    return detectBinary(command || 'agy');
  }

  start(options: DriverStart, onEvent: (event: DriverEvent) => void): AgentProcess {
    const bin = options.command || 'agy';
    const env = agentEnv(options.env);
    const server = serverName(options.agentName, options.agentId);
    let conversation = options.resumeSessionId;
    let current: ChildProcess | undefined;
    let stopped = false;
    let interrupted = false;
    const queue: string[] = [];
    let first = conversation === null;

    const register = spawnSync(bin, ['mcp', 'add', ...Object.entries(options.mcp.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), server, options.mcp.command, ...options.mcp.args], { env, encoding: 'utf8', timeout: 30_000 });
    if (register.error || register.status !== 0) {
      queueMicrotask(() => onEvent({ type: 'exit', code: register.status, error: `agy mcp add failed: ${(register.stderr || register.error?.message || '').trim().slice(0, 300)}` }));
      return { send: () => {}, interrupt: () => {}, stop: () => {} };
    }
    const unregister = () => spawnSync(bin, ['mcp', 'remove', server], { env, timeout: 30_000 });

    const runTurn = (text: string) => {
      const prompt = first
        ? `${options.systemPrompt}\nYour Round Table tools are on the MCP server named "${server}" (call them with call_mcp_tool). Never use another rt-* server: those belong to other agents.\n\n${text}`
        : text;
      first = false;
      interrupted = false;
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        ...(conversation ? ['--conversation', conversation] : []),
        ...(options.model ? ['--model', options.model] : []),
        ...options.extraArgs,
      ];
      const child = spawn(bin, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      const state = { started: false, ended: false, texts: new Map<number, string>() };
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      createInterface({ input: child.stdout }).on('line', (line) => {
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        for (const out of translate(event, state)) {
          if (out.type === 'session') conversation = out.sessionId;
          onEvent(out);
        }
      });
      child.on('error', (error) => finish(null, error.message));
      child.on('close', (code) => finish(code, stderr.trim().split('\n').slice(-3).join(' ') || null));
      const finish = (code: number | null, error: string | null) => {
        if (current !== child) return;
        current = undefined;
        if (stopped) {
          onEvent({ type: 'exit', code, error: null });
          return;
        }
        if (!state.ended) {
          if (!state.started && !interrupted) {
            // Never got going (not signed in, bad flag, …): a crash, so the supervisor backs off.
            onEvent({ type: 'exit', code, error: error ?? `agy exited with code ${code}` });
            return;
          }
          onEvent({ type: 'turn_end', ok: false, durationMs: 0, sessionCostUsd: null, inputTokens: 0, outputTokens: 0, error: interrupted ? 'interrupted' : (error ?? `agy exited with code ${code}`) });
        }
        const next = queue.shift();
        if (next !== undefined) runTurn(next);
      };
    };

    return {
      send: (text) => {
        if (stopped) return;
        if (current) queue.push(text);
        else runTurn(text);
      },
      interrupt: () => {
        if (!current) return;
        interrupted = true;
        current.kill('SIGINT');
      },
      stop: () => {
        stopped = true;
        queue.length = 0;
        unregister();
        if (current) current.kill('SIGTERM');
        else queueMicrotask(() => onEvent({ type: 'exit', code: 0, error: null }));
      },
    };
  }

  test(options: { command: string; env: Record<string, string>; model: string }) {
    const started = Date.now();
    const args = ['-p', 'Reply with exactly: OK', '--output-format', 'stream-json', ...(options.model ? ['--model', options.model] : [])];
    return new Promise<{ ok: boolean; message: string; ms: number; costUsd: number | null }>((resolve) => {
      const child = spawn(options.command || 'agy', args, { env: agentEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, message: error.message, ms: Date.now() - started, costUsd: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === 'result')?.result as { status?: string; response?: string } | undefined;
        const ok = code === 0 && result?.status === 'SUCCESS' && /\bOK\b/.test(result.response ?? '');
        resolve({ ok, message: ok ? 'Signed in and answering.' : (result?.response ?? (err || out).trim().split('\n').slice(-3).join(' ')) || `exit ${code}`, ms: Date.now() - started, costUsd: null });
      });
    });
  }
}

/** One MCP server name per agent, e.g. rt-ada-4k2p9z: readable, stable across restarts, unique. */
export function serverName(name: string, agentId: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'agent';
  return `rt-${slug}-${agentId.slice(-6).toLowerCase()}`;
}

/** agy's stream-json events (S8, agy 1.2.11) → driver events. */
function translate(event: Record<string, any>, state: { started: boolean; ended: boolean; texts: Map<number, string> }): DriverEvent[] {
  if (event.event === 'init') {
    state.started = true;
    return typeof event.conversation_id === 'string' ? [{ type: 'session', sessionId: event.conversation_id }] : [];
  }
  if (event.event === 'step_update' && event.step_update) {
    const s = event.step_update;
    if (s.step_type === 'tool' && s.state === 'ACTIVE') {
      const p = s.tool_info?.parameters ?? {};
      const name = s.tool_name === 'call_mcp_tool' ? `mcp__${p.ServerName}__${p.ToolName}` : String(s.tool_name);
      return [{ type: 'tool', name, input: JSON.stringify(s.tool_name === 'call_mcp_tool' ? (p.Arguments ?? {}) : p).slice(0, 300) }];
    }
    if (s.step_type === 'agent_response') {
      const text = (state.texts.get(s.step_index) ?? '') + (typeof s.text_delta === 'string' ? s.text_delta : '');
      state.texts.set(s.step_index, text);
      if (s.state === 'DONE' && text.trim()) return [{ type: 'text', text: text.trim() }];
    }
    return [];
  }
  if (event.event === 'result' && event.result) {
    state.ended = true;
    const r = event.result;
    const usage = r.usage ?? {};
    const ok = r.status === 'SUCCESS';
    return [{
      type: 'turn_end',
      ok,
      durationMs: Math.round(Number(r.duration_seconds ?? 0) * 1000),
      sessionCostUsd: null, // agy reports tokens, not money
      inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_read_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0) + Number(usage.thinking_tokens ?? 0),
      error: ok ? null : String(r.status ?? 'error'),
    }];
  }
  return [];
}
