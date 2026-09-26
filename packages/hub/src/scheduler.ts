/**
 * Persisted timers (ADR-0010). Timers are `timer.scheduled` / `timer.cancelled` events; the
 * scheduler only watches the earliest due time and dispatches the stored command through the bus.
 */
export interface ScheduledTimer {
  timerId: string;
  dueAt: number;
  /** An internal command (principal kind `hub`), e.g. `roster.mark_stale`. */
  command: { name: string; input: unknown };
}

export interface Scheduler {
  /** Loads pending timers (after restart, overdue ones fire at once, in dueAt order). */
  load(timers: readonly ScheduledTimer[]): void;
  add(timer: ScheduledTimer): void;
  cancel(timerId: string): void;
  start(dispatch: (timer: ScheduledTimer) => void): void;
  stop(): void;
}
