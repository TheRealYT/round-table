import { PRIORITIES, type InboxCounts } from '@round-table/protocol';

/**
 * The piggyback banner (ADR-0001): appended to every Round Table tool result so a busy agent
 * learns about waiting messages at its next call. Empty when nothing is pending.
 */
export function inboxBanner(counts: InboxCounts, activityDue = false): string {
  const parts = PRIORITIES.filter((p) => counts[p] > 0).map((p) => `${counts[p]} ${p}`);
  const notes: string[] = [];
  if (parts.length > 0) {
    const urgent = counts.human > 0 || counts.critical > 0;
    notes.push(`inbox: ${parts.join(' · ')}${urgent ? ' (call wait now)' : ''}`);
  }
  if (activityDue) notes.push('activity report due');
  return notes.length === 0 ? '' : `⟪${notes.join(' | ')}⟫`;
}
