/** Formats hub results for the model: compact, readable, stable. */

export interface WaitItem {
  deliveryId: number;
  id: string;
  from: string;
  role: string;
  priority: string;
  type: string;
  body: string;
  ref: string | null;
  ts: number;
}

export function formatItems(items: readonly WaitItem[], more: number): string {
  if (items.length === 0) return 'No new messages.';
  const lines = items.map((m) => {
    const who = m.role === 'human' ? 'human' : `${m.from} (${m.role})`;
    const ref = m.ref ? ` re ${m.ref}` : '';
    return `- [${m.priority}] ${m.type} from ${who}${ref}, ${m.id}: ${m.body}`;
  });
  if (more > 0) lines.push(`(${more} more waiting; call wait again)`);
  return lines.join('\n');
}

export function formatResult(value: unknown): string {
  if (value === null || value === undefined) return 'ok';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
