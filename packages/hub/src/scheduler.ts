import type { Clock } from '@round-table/core';

/**
 * Persisted timers (ADR-0010). Timers are `timer.scheduled` / `timer.cancelled` events; the
 * scheduler only keeps them in due order and fires the stored command through the bus.
 */
export interface ScheduledTimer {
  timerId: string;
  dueAt: number;
  /** An internal command (principal kind `hub`), e.g. `roster.mark_stale`. */
  command: { name: string; input: unknown };
}

export interface Scheduler {
  /** Loads pending timers (after a restart, overdue ones fire at once, in due order). */
  load(timers: readonly ScheduledTimer[]): void;
  add(timer: ScheduledTimer): void;
  cancel(timerId: string): void;
  start(dispatch: (timer: ScheduledTimer) => void): void;
  stop(): void;
}

/**
 * Fires due timers on `tick()`. With `auto`, it also arms a real setTimeout for the earliest
 * timer; scenario tests leave `auto` off and call `tick()` after moving a FakeClock.
 */
export class TimerScheduler implements Scheduler {
  private readonly timers = new Map<string, ScheduledTimer>();
  private readonly clock: Clock;
  private readonly auto: boolean;
  private dispatch: ((timer: ScheduledTimer) => void) | undefined;
  private handle: ReturnType<typeof setTimeout> | undefined;
  private firing = false;

  constructor(options: { clock: Clock; auto: boolean }) {
    this.clock = options.clock;
    this.auto = options.auto;
  }

  load(timers: readonly ScheduledTimer[]): void {
    for (const t of timers) this.timers.set(t.timerId, t);
    this.arm();
  }

  add(timer: ScheduledTimer): void {
    this.timers.set(timer.timerId, timer);
    this.arm();
  }

  cancel(timerId: string): void {
    this.timers.delete(timerId);
    this.arm();
  }

  start(dispatch: (timer: ScheduledTimer) => void): void {
    this.dispatch = dispatch;
    this.arm();
  }

  stop(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = undefined;
    this.dispatch = undefined;
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Fires every timer due at the current clock time, earliest first. Returns how many fired. */
  tick(): number {
    if (!this.dispatch || this.firing) return 0;
    this.firing = true;
    let fired = 0;
    try {
      for (;;) {
        const due = [...this.timers.values()].filter((t) => t.dueAt <= this.clock.now()).sort((a, b) => a.dueAt - b.dueAt || a.timerId.localeCompare(b.timerId));
        const next = due[0];
        if (!next) break;
        this.timers.delete(next.timerId);
        this.dispatch(next);
        fired += 1;
      }
    } finally {
      this.firing = false;
    }
    this.arm();
    return fired;
  }

  private arm(): void {
    if (!this.auto || !this.dispatch) return;
    if (this.handle) clearTimeout(this.handle);
    this.handle = undefined;
    let earliest = Infinity;
    for (const t of this.timers.values()) earliest = Math.min(earliest, t.dueAt);
    if (earliest === Infinity) return;
    const delay = Math.max(0, Math.min(earliest - this.clock.now(), 2 ** 31 - 1));
    this.handle = setTimeout(() => this.tick(), delay);
    this.handle.unref?.();
  }
}
