import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Random } from '../../src/contracts/env.js';
import {
  REPLICA_ID_PATTERN,
  base32,
  newMutationId,
  newRecordId,
  newReplicaId,
  platformRandom,
  randomFloat,
} from '../../src/ops/random.js';

const fixed = (...bytes: number[]): Random => ({
  randomBytes: (n) => Uint8Array.from(bytes.slice(0, n)),
});

/** A tiny deterministic generator for tests (xorshift32). */
function seeded(seed: number): Random {
  let s = seed >>> 0 || 1;
  return {
    randomBytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        out[i] = s & 0xff;
      }
      return out;
    },
  };
}

describe('randomFloat (unsigned big-endian, 53 bits)', () => {
  it('pins the byte order with fixed vectors', () => {
    expect(randomFloat(fixed(0x80, 0, 0, 0, 0, 0, 0, 0))).toBe(0.5);
    expect(randomFloat(fixed(0, 0, 0, 0, 0, 0, 0x08, 0))).toBe(2 ** -53);
    expect(randomFloat(fixed(0, 0x08, 0, 0, 0, 0, 0, 0))).not.toBe(2 ** -53);
    expect(randomFloat(fixed(0, 0, 0, 0, 0, 0, 0, 0))).toBe(0);
    expect(randomFloat(fixed(255, 255, 255, 255, 255, 255, 255, 255))).toBe(
      (2 ** 53 - 1) / 2 ** 53,
    );
    expect(randomFloat(fixed(255, 255, 255, 255, 255, 255, 255, 255))).toBeLessThan(1);
  });

  it('is always in [0, 1)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 8 }), (bytes) => {
        const x = randomFloat({ randomBytes: () => bytes });
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }),
    );
  });

  it('rejects a source that returns too few bytes', () => {
    expect(() => randomFloat(fixed(1, 2, 3))).toThrow(RangeError);
  });
});

describe('identifiers', () => {
  it('base32 follows RFC 4648 (lowercase, no padding)', () => {
    expect(base32(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi');
    expect(base32(new Uint8Array([]))).toBe('');
  });

  it('replica and mutation IDs are 26 base32 characters; record IDs are 32 hex', () => {
    const r = seeded(7);
    expect(newReplicaId(r)).toMatch(REPLICA_ID_PATTERN);
    expect(newMutationId(r)).toMatch(/^[a-z2-7]{26}$/);
    expect(newMutationId(r)).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(newRecordId(r)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('IDs are reproducible from a seeded Random', () => {
    expect(newReplicaId(seeded(42))).toBe(newReplicaId(seeded(42)));
    expect(newMutationId(seeded(42))).toBe(newMutationId(seeded(42)));
    expect(newRecordId(seeded(1))).not.toBe(newRecordId(seeded(2)));
  });

  it('platformRandom returns the requested length, also above the 65536-byte chunk size', () => {
    expect(platformRandom.randomBytes(16)).toHaveLength(16);
    expect(platformRandom.randomBytes(70_000)).toHaveLength(70_000);
    expect(newReplicaId(platformRandom)).not.toBe(newReplicaId(platformRandom));
  });
});
