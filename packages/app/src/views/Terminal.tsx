import { useEffect, useRef, useState } from 'react';
import { Plus, SquareTerminal, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * The human's terminals (S2c, ADR-0021): a shell on the hub machine, in the repository or an
 * agent's worktree, docked at the bottom of the project page. Several at once, as tabs.
 */
export interface TermTab { id: number; worktree: string | null; label: string }

export function TerminalDock({ projectId, tabs, active, onActive, onClose, onNew, height }: { projectId: string; tabs: TermTab[]; active: number; onActive: (id: number) => void; onClose: (id: number) => void; onNew: () => void; height: number }) {
  return (
    <section className="term-dock" style={{ height }} aria-label="Terminal">
      <div className="term-tabs" role="tablist">
        <SquareTerminal />
        {tabs.map((t) => (
          <span key={t.id} className={`term-tab ${t.id === active ? 'on' : ''}`}>
            <button role="tab" aria-selected={t.id === active} onClick={() => onActive(t.id)} title={t.worktree ?? 'the repository'}>{t.label}</button>
            <button className="x" aria-label={`Close ${t.label}`} onClick={() => onClose(t.id)}><X /></button>
          </span>
        ))}
        <button className="ghost icon sm" aria-label="New terminal" title="New terminal in the repository" onClick={onNew}><Plus /></button>
        <span className="spacer" />
        <span className="faint xs">A shell on the hub machine. Nothing you type is logged.</span>
      </div>
      {tabs.map((t) => <TermView key={t.id} projectId={projectId} tab={t} visible={t.id === active} />)}
    </section>
  );
}

function TermView({ projectId, tab, visible }: { projectId: string; tab: TermTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>(null);
  const [status, setStatus] = useState<string>('connecting…');
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: css.getPropertyValue('--mono') || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: { background: '#0f1115', foreground: '#d6d9e0', cursor: '#f5b33d', selectionBackground: '#f5b33d55' },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    const q = new URLSearchParams({ projectId, cols: String(term.cols), rows: String(term.rows), ...(tab.worktree && { worktree: tab.worktree }) });
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/term?${q}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; data?: string; cwd?: string; code?: number; message?: string };
      if (m.type === 'output' && m.data) term.write(m.data);
      if (m.type === 'ready') setStatus('');
      if (m.type === 'exit') setStatus(`exited (${m.code})`);
      if (m.type === 'error') setStatus(m.message ?? 'error');
    };
    ws.onclose = () => setStatus((s) => s || 'closed');
    ws.onerror = () => setStatus('The hub refused the terminal (logged out, or turned off in Settings).');
    const input = term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'input', data })));
    const resized = term.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'resize', cols, rows })));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      input.dispose();
      resized.dispose();
      ws.close();
      term.dispose();
    };
  }, [projectId, tab.worktree]);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitRef.current?.fit());
  }, [visible]);
  return (
    <div className="term-view" hidden={!visible}>
      {status && <div className="term-status">{status}</div>}
      <div ref={host} className="term-host" />
    </div>
  );
}
