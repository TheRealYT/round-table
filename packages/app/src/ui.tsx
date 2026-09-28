import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, CircleX, Crown, Moon, Monitor, Sun, X } from 'lucide-react';
import type { LiveState, RosterRecord, RunStatus } from './types.ts';
import { toolName } from './format.ts';
import { LOGOS } from './logos.ts';

// ── status ─────────────────────────────────────────────────────────────────────────────

export type Seat = RunStatus | 'warn';

/** No tool call for this long (outside wait) means a chat-joined agent's chat isn't running. */
export const STOPPED_AFTER_MS = 90_000;

/** One status word for any agent: hub-run agents from the supervisor, chat agents from attention. */
export function seatOf(agent: RosterRecord, now: number): Seat {
  if (agent.driven) return agent.driven.live.status;
  if (!agent.connected || agent.state !== 'active') return 'stopped';
  const seen = agent.attention;
  if (!seen || seen.stopped || (!seen.waiting && now - seen.lastCallAt > STOPPED_AFTER_MS)) return 'warn';
  return seen.waiting ? 'idle' : 'working';
}

export const SEAT_LABEL: Record<Seat, string> = { working: 'working', idle: 'idle', starting: 'starting', stopped: 'stopped', crashed: 'crashed', warn: 'needs you' };

export function RunState({ live }: { live: LiveState | null | undefined }) {
  const status = live?.status ?? 'stopped';
  return (
    <span className={`status ${status}`} title={live?.lastError ?? undefined}>
      <span className="dot" aria-hidden />
      {SEAT_LABEL[status]}
      {status === 'working' && live?.tool ? <span className="sub">{toolName(live.tool)}</span> : null}
    </span>
  );
}

export function useNow(ms = 5_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── avatar ─────────────────────────────────────────────────────────────────────────────

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)).toUpperCase();
}

export function Avatar({ name, seat, leader, size }: { name: string; seat?: Seat; leader?: boolean; size?: 'xs' | 'lg' }) {
  return (
    <span className={`avatar ${seat ?? ''} ${size ?? ''}`} title={name} aria-hidden>
      {leader && <Crown className="crown" />}
      {initials(name)}
    </span>
  );
}

// ── toasts ─────────────────────────────────────────────────────────────────────────────

interface Toast { id: number; text: string; bad: boolean }
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, bad = false) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 6_000 : 3_500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>
            {t.bad ? <CircleX /> : <Check />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ── sheet (side dialog) ───────────────────────────────────────────────────────────────

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={typeof title === 'string' ? title : undefined}>
      {open && (
        <div className="sheet-inner">
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="ghost icon" onClick={onClose} aria-label="Close"><X /></button>
          </div>
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ── sparkline ──────────────────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 120, height = 28, label }: { values: number[]; width?: number; height?: number; label: string }) {
  if (values.length < 2) return <svg width={width} height={height} role="img" aria-label={`${label}: not enough data yet`} />;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill="var(--accent-soft)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

// ── theme ──────────────────────────────────────────────────────────────────────────────

type Theme = 'system' | 'dark' | 'light';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('rt-theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyStoredTheme(): void {
  const t = readTheme();
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const choose = (t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem('rt-theme', t);
    } catch {
      // private mode: the choice lasts for this page only
    }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = t;
  };
  const nextOf: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <button className="ghost icon sm" onClick={() => choose(nextOf[theme])} aria-label={`Theme: ${theme}. Switch to ${nextOf[theme]}`} title={`Theme: ${theme}`}>
      <Icon />
    </button>
  );
}

// ── progress by task status ────────────────────────────────────────────────────────────

export const TASK_COLUMNS = ['proposed', 'ready', 'claimed', 'in_progress', 'in_review', 'in_test', 'done'] as const;
export const TASK_COLOR: Record<string, string> = {
  proposed: 'var(--text-faint)',
  ready: 'var(--idle)',
  claimed: 'var(--starting)',
  in_progress: 'var(--accent)',
  in_review: 'oklch(0.72 0.14 300)',
  in_test: 'oklch(0.75 0.13 330)',
  done: 'var(--working)',
};

export function TaskProgress({ counts }: { counts: Record<string, number> }) {
  const total = TASK_COLUMNS.reduce((n, c) => n + (counts[c] ?? 0), 0);
  if (total === 0) return <div className="progress" aria-label="No tasks yet" />;
  return (
    <div className="progress" role="img" aria-label={TASK_COLUMNS.filter((c) => counts[c]).map((c) => `${counts[c]} ${c.replace('_', ' ')}`).join(', ')}>
      {TASK_COLUMNS.filter((c) => counts[c]).map((c) => <i key={c} style={{ width: `${(100 * (counts[c] ?? 0)) / total}%`, background: TASK_COLOR[c] }} />)}
    </div>
  );
}

// ── provider logos ─────────────────────────────────────────────────────────────────────

/** The CLI's brand mark (see logos.ts), or a letter mark when it has none. */
export function ProviderLogo({ kind, size }: { kind: string; size?: 'sm' | 'xs' }) {
  const logo = LOGOS[kind];
  const letters: Record<string, string> = { codex: 'CX' };
  return (
    <span className={`logo ${kind} ${size ?? ''}`} aria-hidden style={logo ? ({ '--brand': logo.hex } as CSSProperties) : undefined}>
      {logo ? <svg viewBox="0 0 24 24"><path d={logo.path} /></svg> : (letters[kind] ?? kind.slice(0, 2).toUpperCase())}
    </span>
  );
}
