/**
 * Deterministic test environment (design 12.2, R15.21): a seeded `Random` (SplitMix64), a fake
 * wall `Clock` and a fake `Scheduler`. Same seed, same bytes, on every platform.
 */
import type { Clock, Random, Scheduler } from '@weave/core/protocol';

const MASK64 = (1n << 64n) - 1n;

function seedToBigInt(seed: number | bigint | string): bigint {
  if (typeof seed === 'bigint') return seed & MASK64;
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed))
      throw new RangeError('seededRandom: seed must be a safe integer');
    return BigInt.asUintN(64, BigInt(seed));
  }
  // FNV-1a 64 over the UTF-16 code units of the string seed.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < seed.length; i++) {
    h ^= BigInt(seed.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

/** SplitMix64 (Steele, Lea, Flood 2014). Each step yields 8 bytes, most significant first. */
export function seededRandom(seed: number | bigint | string): Random {
  let state = seedToBigInt(seed);
  let buffer: number[] = [];
  const nextWord = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
  return {
    randomBytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        if (buffer.length === 0) {
          const w = nextWord();
          buffer = Array.from({ length: 8 }, (_, k) => Number((w >> BigInt(56 - 8 * k)) & 0xffn));
        }
        out[i] = buffer.shift()!;
      }
      return out;
    },
  };
}

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A wall clock that only moves when told to. */
export function fakeClock(startMs = 1_700_000_000_000): FakeClock {
  let now = startMs;
  return {
    nowMs: () => now,
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
  };
}

export interface FakeScheduler extends Scheduler {
  /** Every requested sleep, in order. */
  readonly sleeps: number[];
  advance(ms: number): void;
}

/**
 * Monotonic time that only moves on `sleep` (by the requested amount) or `advance`. `sleep`
 * resolves on the next microtask, so retry loops run instantly and deterministically.
 */
export function fakeScheduler(startMs = 0): FakeScheduler {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    monotonicMs: () => now,
    sleep(ms) {
      sleeps.push(ms);
      now += Math.max(0, ms);
      return Promise.resolve();
    },
    advance(ms) {
      now += ms;
    },
  };
}

/** Fisher-Yates shuffle driven by a `Random` (a copy; the input is not changed). */
export function shuffleWith<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const b = random.randomBytes(4);
    const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    const j = r % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A uniform integer in [0, n). */
export function randomInt(random: Random, n: number): number {
  const b = random.randomBytes(4);
  return (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) % Math.max(1, n);
}

/** True with probability `p`. */
export function chance(random: Random, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return randomInt(random, 1_000_000) < p * 1_000_000;
}
