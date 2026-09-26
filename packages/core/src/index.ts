// Pure domain core (ADR-0010): no IO, no clock, no randomness. Everything arrives via ctx.
export * from './ports.ts';
export * from './module.ts';
export * from './tasks/status.ts';
export * from './tasks/done-rule.ts';
