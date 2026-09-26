import { PRIORITIES, type InboxCounts } from '@round-table/protocol';

/** Every line rt-agent adds to a tool result starts with this, and the server instructions define it (S0 finding 6). */
export const STATUS_PREFIX = '[Round Table]';

/**
 * The piggyback status line (ADR-0001): appended to every Round Table tool result so a busy agent
 * learns about waiting messages at its next call. Factual, never imperative: the model ignored an
 * imperative banner as a possible injection in S0. Empty when there is nothing to report.
 */
export function inboxBanner(counts: InboxCounts, activityDue = false): string {
  const waiting = PRIORITIES.filter((p) => counts[p] > 0);
  const parts: string[] = [];
  if (waiting.length > 0) {
    const total = waiting.reduce((n, p) => n + counts[p], 0);
    const detail = waiting.map((p) => `${counts[p]} ${p}`).join(', ');
    parts.push(`inbox: ${total} message${total === 1 ? '' : 's'} waiting (${detail}). Read with wait.`);
  }
  if (activityDue) parts.push('activity report due (no activity call in the last 5 min).');
  return parts.length === 0 ? '' : `${STATUS_PREFIX} ${parts.join(' ')}`;
}
