export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortId(id: string): string {
  const [prefix, rest] = id.split('_');
  return rest ? `${prefix}_…${rest.slice(-6)}` : id;
}

export function usd(value: number): string {
  if (value === 0) return '$0';
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** mcp__roundtable__board_propose → board_propose; Bash stays Bash. */
export function toolName(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, '');
}
