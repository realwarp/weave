/**
 * Retry with exponential backoff and full jitter (R10.2, R10.3, design 8.4).
 * delay = randomFloat(random) * min(capMs, baseMs * 2^n) for the n-th retry (n starts at 0).
 * Timing comes from the injected `Scheduler`; jitter from the injected `Random`. Nothing here
 * reads the wall clock or `Math.random`, and no stored data depends on the timing.
 */
import type { Random, Scheduler } from '../contracts/env.js';
import { WeaveError, type ErrorCode } from '../contracts/errors.js';
import { randomFloat as defaultRandomFloat } from '../ops/random.js';

export interface RetryPolicy {
  /** Total attempts including the first (default 6). */
  readonly attempts: number;
  readonly baseMs: number;
  readonly capMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 6, baseMs: 250, capMs: 30_000 };

export interface RetryDeps {
  readonly random: Random;
  readonly scheduler: Scheduler;
  readonly onRetry?: (event: { attempt: number; delayMs: number; code: ErrorCode }) => void;
  /** Override for tests; defaults to `randomFloat`. */
  readonly randomFloat?: (random: Random) => number;
}

/** Only errors explicitly marked retryable (transport failures, 5xx, 429, timeouts) are retried. */
export function isRetryable(error: unknown): boolean {
  return error instanceof WeaveError && error.retryable;
}

export function backoffDelay(
  policy: RetryPolicy,
  retryIndex: number,
  random: Random,
  floatOf: (random: Random) => number = defaultRandomFloat,
): number {
  const bound = Math.min(policy.capMs, policy.baseMs * 2 ** retryIndex);
  return floatOf(random) * bound;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  const attempts = Math.max(1, policy.attempts);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;
      const delayMs = backoffDelay(policy, attempt, deps.random, deps.randomFloat);
      deps.onRetry?.({ attempt: attempt + 1, delayMs, code: (error as WeaveError).code });
      await deps.scheduler.sleep(delayMs);
    }
  }
  throw lastError;
}
