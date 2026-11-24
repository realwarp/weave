import { describe, expect, it } from 'vitest';
import type { Random, Scheduler } from '../../src/contracts/env.js';
import { WeaveError } from '../../src/contracts/errors.js';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  isRetryable,
  withRetry,
} from '../../src/sync/retry.js';

function fakeScheduler(): Scheduler & { sleeps: number[] } {
  const sleeps: number[] = [];
  let now = 0;
  return {
    sleeps,
    monotonicMs: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

/** Each call returns the next 8-byte block of a fixed counter, so floats are predictable. */
function countingRandom(): Random {
  let i = 0;
  return {
    randomBytes: (n) => {
      i += 1;
      const out = new Uint8Array(n);
      out[0] = (i * 37) & 0xff;
      return out;
    },
  };
}

const transient = () => new WeaveError('TRANSPORT_ERROR', 'down', { retryable: true });

describe('retry policy (R10.2, R10.3)', () => {
  it('classifies only retryable WeaveErrors as retryable', () => {
    expect(isRetryable(transient())).toBe(true);
    expect(isRetryable(new WeaveError('TRANSPORT_ERROR', '4xx'))).toBe(false);
    expect(isRetryable(new WeaveError('INTEGRITY_CONFLICT', 'x'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('produces the exact full-jitter delay sequence, including the cap', async () => {
    const scheduler = fakeScheduler();
    const policy = { attempts: 8, baseMs: 250, capMs: 5_000 };
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw transient();
        },
        policy,
        { random: countingRandom(), scheduler },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    expect(calls).toBe(8);
    const expected = Array.from({ length: 7 }, (_, n) =>
      backoffDelay(policy, n, {
        randomBytes: () => Uint8Array.from([((n + 1) * 37) & 0xff, 0, 0, 0, 0, 0, 0, 0]),
      }),
    );
    expect(scheduler.sleeps).toEqual(expected);
    // bounds: 250, 500, 1000, 2000, 4000, 5000 (cap), 5000
    expect(scheduler.sleeps.every((d, n) => d < Math.min(5_000, 250 * 2 ** n))).toBe(true);
  });

  it('a stubbed float of 0 gives no delay; the maximum stays just under the bound', async () => {
    for (const [float, check] of [
      [0, (d: number, bound: number) => expect(d).toBe(0 * bound)],
      [(2 ** 53 - 1) / 2 ** 53, (d: number, bound: number) => expect(d).toBeLessThan(bound)],
    ] as const) {
      const scheduler = fakeScheduler();
      await withRetry(
        async (attempt) => {
          if (attempt < 3) throw transient();
          return 'ok';
        },
        DEFAULT_RETRY_POLICY,
        { random: countingRandom(), scheduler, randomFloat: () => float },
      );
      scheduler.sleeps.forEach((d, n) => check(d, Math.min(30_000, 250 * 2 ** n)));
      expect(scheduler.sleeps).toHaveLength(3);
    }
  });

  it('non-retryable errors propagate immediately; onRetry reports attempts', async () => {
    const scheduler = fakeScheduler();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new WeaveError('VALIDATION_FAILED', 'bad');
        },
        DEFAULT_RETRY_POLICY,
        { random: countingRandom(), scheduler },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toBe(1);
    expect(scheduler.sleeps).toEqual([]);

    const events: number[] = [];
    const result = await withRetry(
      async (attempt) => {
        if (attempt === 0) throw transient();
        return attempt;
      },
      DEFAULT_RETRY_POLICY,
      {
        random: countingRandom(),
        scheduler: fakeScheduler(),
        onRetry: (e) => events.push(e.attempt),
      },
    );
    expect(result).toBe(1);
    expect(events).toEqual([1]);
  });

  it('is reproducible: the same Random gives the same delays', async () => {
    const run = async () => {
      const scheduler = fakeScheduler();
      await withRetry(
        async (a) => {
          if (a < 4) throw transient();
          return a;
        },
        DEFAULT_RETRY_POLICY,
        { random: countingRandom(), scheduler },
      );
      return scheduler.sleeps;
    };
    expect(await run()).toEqual(await run());
  });
});
