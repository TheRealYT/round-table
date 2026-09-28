import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * The human's terminal (S2c, ADR-0021): a shell on the hub machine, in the project's repository or
 * one of its worktrees, streamed to the app over its own WebSocket (`/term`). Human only (the login
 * cookie), same origin only, and off when the settings say so. It is not a procedure: a raw shell
 * is not part of the Round Table's event model, and nothing typed in it is logged.
 */

export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number) => void): void;
}

interface NodePty {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): {
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
    onData(h: (d: string) => void): void;
    onExit(h: (e: { exitCode: number }) => void): void;
  };
}

// A dependency-free PTY for Linux and macOS when node-pty isn't installed: python's pty module,
// with window size changes arriving on fd 3 as "cols rows" lines.
const PY_PTY = `
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-i'])
def size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
size(cols, rows)
fds, buf = [fd, 0, 3], b''
while True:
    try:
        ready, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(fd, data)
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            fds.remove(3)
            continue
        buf += data
        while b'\\n' in buf:
            line, buf = buf.split(b'\\n', 1)
            try:
                c, r = line.split()
                size(int(c), int(r))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;

export async function openPty(options: { cwd: string; cols: number; rows: number; env?: Record<string, string> }): Promise<Pty> {
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const env = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor', ...options.env };
  const nodePty = await import('node-pty').then((m) => (m as { default?: NodePty }).default ?? (m as unknown as NodePty)).catch(() => undefined);
  if (nodePty) {
    const p = nodePty.spawn(shell, process.platform === 'win32' ? [] : ['-i'], { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env });
    return { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill(), onData: (h) => p.onData(h), onExit: (h) => p.onExit((e) => h(e.exitCode)) };
  }
  if (process.platform === 'win32') throw new Error('the terminal needs node-pty on Windows');
  const child = spawn('python3', ['-c', PY_PTY, String(options.cols), String(options.rows), shell], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const control = child.stdio[3] as NodeJS.WritableStream;
  child.stdout.setEncoding('utf8');
  return {
    write: (d) => child.stdin.write(d),
    resize: (c, r) => control.write(`${c} ${r}\n`),
    kill: () => child.kill('SIGTERM'),
    onData: (h) => {
      child.stdout.on('data', (d: string) => h(d));
      child.stderr.on('data', (d: Buffer) => h(d.toString()));
    },
    onExit: (h) => {
      child.on('exit', (code) => h(code ?? 0));
      child.on('error', () => h(127));
    },
  };
}

export interface TerminalAccess {
  /** Is this cookie a logged-in human, and may the terminal be used? */
  allowed(cookie: string | undefined): boolean;
  /** Where a terminal for this request may start (the repo or one of its worktrees), or why not. */
  cwdFor(projectId: string, worktree: string | null): Promise<string>;
}

/** Handles `/term` upgrades on the hub's HTTP server. Messages: {input} and {resize} in, {output} and {exit} out. */
export function attachTerminal(httpServer: { on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }, access: TerminalAccess): void {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/term') return;
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    const cookie = /(?:^|;\s*)rt_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    // Same origin only (no other site may open a shell), a logged-in human, and the setting on.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && new URL(origin).host !== host) || !access.allowed(cookie && decodeURIComponent(cookie))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void serve(ws, url, access));
  });
}

async function serve(ws: WebSocket, url: URL, access: TerminalAccess): Promise<void> {
  const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let pty: Pty;
  try {
    const cwd = await access.cwdFor(url.searchParams.get('projectId') ?? '', url.searchParams.get('worktree'));
    const cols = clamp(Number(url.searchParams.get('cols')) || 100, 20, 500);
    const rows = clamp(Number(url.searchParams.get('rows')) || 30, 5, 200);
    pty = await openPty({ cwd, cols, rows });
    send({ type: 'ready', cwd });
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    ws.close();
    return;
  }
  pty.onData((data) => send({ type: 'output', data }));
  pty.onExit((code) => {
    send({ type: 'exit', code });
    ws.close();
  });
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
      if (m.type === 'input' && typeof m.data === 'string') pty.write(m.data);
      if (m.type === 'resize') pty.resize(clamp(Number(m.cols) || 80, 20, 500), clamp(Number(m.rows) || 24, 5, 200));
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on('close', () => pty.kill());
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
