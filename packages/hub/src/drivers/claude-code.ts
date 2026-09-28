import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { AgentProcess, Driver, DriverEvent, DriverStart } from './driver.ts';
import { agentEnv, detectBinary } from './process.ts';

/**
 * Claude Code headless (S8, verified on 2.1.283): one long-lived `claude -p` per agent with
 * stream-json in and out. Messages are user lines on stdin; each turn ends with a `result` event
 * carrying cost and usage; an interrupt is a control request; `--resume` continues the session.
 */
export class ClaudeCodeDriver implements Driver {
  detect(command: string) {
    return detectBinary(command || 'claude');
  }

  start(options: DriverStart, onEvent: (event: DriverEvent) => void): AgentProcess {
    const session = options.resumeSessionId ? ['--resume', options.resumeSessionId] : ['--session-id', randomUUID()];
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', JSON.stringify({ mcpServers: { roundtable: options.mcp } }),
      '--strict-mcp-config',
      '--append-system-prompt', options.systemPrompt,
      ...session,
      ...(options.model ? ['--model', options.model] : []),
      ...(options.effort ? ['--effort', options.effort] : []),
      ...options.extraArgs,
    ];
    const child = spawn(options.command || 'claude', args, { cwd: options.cwd, env: agentEnv(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let exited = false;
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      for (const out of translate(event)) onEvent(out);
    });
    const finish = (code: number | null, error: string | null) => {
      if (exited) return;
      exited = true;
      onEvent({ type: 'exit', code, error });
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code, code === 0 ? null : stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`));
    const write = (message: object) => {
      if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    return {
      send: (text) => write({ type: 'user', message: { role: 'user', content: text } }),
      interrupt: () => write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } }),
      stop: () => {
        child.stdin.end();
        setTimeout(() => {
          if (!exited) child.kill('SIGTERM');
        }, 5_000).unref();
      },
    };
  }

  test(options: { command: string; env: Record<string, string>; model: string }) {
    const started = Date.now();
    const args = ['-p', 'Reply with exactly: OK', '--output-format', 'json', '--max-turns', '1', '--strict-mcp-config', ...(options.model ? ['--model', options.model] : [])];
    return new Promise<{ ok: boolean; message: string; ms: number; costUsd: number | null }>((resolve) => {
      const child = spawn(options.command || 'claude', args, { env: agentEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, message: error.message, ms: Date.now() - started, costUsd: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        try {
          const r = JSON.parse(out) as { is_error?: boolean; result?: string; total_cost_usd?: number };
          const ok = code === 0 && !r.is_error && /\bOK\b/.test(r.result ?? '');
          resolve({ ok, message: ok ? 'Signed in and answering.' : (r.result ?? 'no answer'), ms, costUsd: r.total_cost_usd ?? null });
        } catch {
          resolve({ ok: false, message: (err || out).trim().split('\n').slice(-3).join(' ') || `exit ${code}`, ms, costUsd: null });
        }
      });
    });
  }
}

/** Tool inputs and outputs are kept whole up to this size (the transcript is for reading, not replay). */
const CAP = 20_000;

export function cap(text: string): string {
  return text.length > CAP ? `${text.slice(0, CAP)}\n… (${text.length - CAP} more characters)` : text;
}

/** Claude Code's stream-json events → driver events. */
export function translate(event: Record<string, any>): DriverEvent[] {
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') return [{ type: 'session', sessionId: event.session_id }];
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    return event.message.content.flatMap((c: Record<string, any>): DriverEvent[] => {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) return [{ type: 'text', text: c.text }];
      if (c.type === 'thinking') return [{ type: 'thinking', text: typeof c.thinking === 'string' ? c.thinking : '' }];
      if (c.type === 'redacted_thinking') return [{ type: 'thinking', text: '' }];
      if (c.type === 'tool_use') return [{ type: 'tool', id: String(c.id ?? ''), name: String(c.name), input: cap(JSON.stringify(c.input ?? {})) }];
      return [];
    });
  }
  // Tool results come back as the "user" side of the conversation.
  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    return event.message.content.flatMap((c: Record<string, any>): DriverEvent[] => {
      if (c.type !== 'tool_result') return [];
      const output = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((p: Record<string, any>) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n') : '';
      return [{ type: 'tool_result', id: String(c.tool_use_id ?? ''), output: cap(output), isError: Boolean(c.is_error) }];
    });
  }
  if (event.type === 'result') {
    const usage = event.usage ?? {};
    const ok = event.subtype === 'success' && !event.is_error;
    return [{
      type: 'turn_end',
      ok,
      durationMs: Number(event.duration_ms ?? 0),
      sessionCostUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
      inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      error: ok ? null : String(event.subtype === 'success' ? (event.result ?? 'error') : event.subtype),
    }];
  }
  return [];
}
