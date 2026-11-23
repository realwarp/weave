/**
 * Platform defaults for the injected `Clock` and `Scheduler` (design 2). This is the ONLY engine
 * file allowed to read the platform clock (the ESLint determinism rule exempts it). Wall time is
 * display information only; ordering never depends on it (A5).
 */
import type { Clock, Scheduler } from '../contracts/env.js';

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export const systemScheduler: Scheduler = {
  monotonicMs: () => performance.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};
