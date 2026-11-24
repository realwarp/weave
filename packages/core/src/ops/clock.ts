/**
 * Platform defaults for the injected `Clock` and `Scheduler` (design 2). This is the ONLY engine
 * file allowed to read the platform clock (the ESLint determinism rule exempts it). Wall time is
 * display information only; ordering never depends on it (A5).
 */
import type { Clock, Scheduler } from '../contracts/env.js';

/**
 * A clock implementation that uses the platform's wall-clock time.
 * Used ONLY for display values such as `wallTime` and `lastSyncWall` (A5).
 */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

/**
 * A scheduler implementation that uses the platform's monotonic timer and setTimeout.
 * Used only for retry backoff, never for stored data (R10.2).
 */
export const systemScheduler: Scheduler = {
  monotonicMs: () => performance.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};
