import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertSupported, toCanonical } from '../../core/src/canonical/index.js';
import { randomFloat } from '../../core/src/ops/random.js';
import { fakeClock, fakeScheduler, seededRandom, shuffleWith } from '../src/faults/index.js';
import {
  arbFields,
  arbFrontierEntries,
  arbJsonValue,
  arbOpPayload,
  arbReplicaId,
  arbVersionVector,
} from '../src/generators/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('seededRandom (SplitMix64)', () => {
  it('matches the reference SplitMix64 outputs for seed 0', () => {
    // Reference values of SplitMix64 with state 0 (first two outputs), most significant byte first.
    expect(hex(seededRandom(0).randomBytes(16))).toBe('e220a8397b1dcdaf6e789e6aa1b965f4');
  });

  it('same seed gives the same bytes; different seeds differ; chunking does not matter', () => {
    expect(hex(seededRandom(42).randomBytes(40))).toBe(hex(seededRandom(42).randomBytes(40)));
    expect(hex(seededRandom(42).randomBytes(16))).not.toBe(hex(seededRandom(43).randomBytes(16)));
    expect(hex(seededRandom('a').randomBytes(8))).not.toBe(hex(seededRandom('b').randomBytes(8)));
    const r = seededRandom(7);
    const pieces = [r.randomBytes(3), r.randomBytes(5), r.randomBytes(9)];
    expect(pieces.map(hex).join('')).toBe(hex(seededRandom(7).randomBytes(17)));
  });

  it('feeds randomFloat with values in [0, 1)', () => {
    const r = seededRandom(1);
    for (let i = 0; i < 1000; i++) {
      const x = randomFloat(r);
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('shuffleWith is a deterministic permutation', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = shuffleWith(items, seededRandom(5));
    expect(a).toEqual(shuffleWith(items, seededRandom(5)));
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });
});

describe('fake clock and scheduler', () => {
  it('the clock moves only when told', () => {
    const c = fakeClock(1000);
    expect(c.nowMs()).toBe(1000);
    c.advance(5);
    expect(c.nowMs()).toBe(1005);
    c.set(1);
    expect(c.nowMs()).toBe(1);
  });

  it('the scheduler records sleeps and advances monotonic time', async () => {
    const s = fakeScheduler();
    await s.sleep(250);
    await s.sleep(500);
    expect(s.sleeps).toEqual([250, 500]);
    expect(s.monotonicMs()).toBe(750);
  });
});

describe('generators produce valid values', () => {
  it('replica IDs, vectors, values and fields', () => {
    fc.assert(
      fc.property(
        arbReplicaId(),
        arbVersionVector(),
        arbJsonValue(),
        arbFields(),
        (id, v, value, fields) => {
          expect(id).toMatch(/^[a-z2-7]{26}$/);
          expect(Object.values(v).every((n) => Number.isSafeInteger(n) && n > 0)).toBe(true);
          expect(() => assertSupported(value)).not.toThrow();
          expect(() => toCanonical(fields)).not.toThrow();
        },
      ),
    );
  });

  it('op payloads respect the writer context rule', () => {
    fc.assert(
      fc.property(arbOpPayload(), (p) => {
        expect(p.context[p.replicaId] ?? 0).toBe(p.seq - 1);
        if (p.kind === 'delete') expect(p.fields).toEqual({});
      }),
    );
  });

  it('frontier entries are internally consistent and unique', () => {
    fc.assert(
      fc.property(arbFrontierEntries(fc.integer()), (entries) => {
        const ids = entries.map((e) => `${e.opId.replicaId}:${e.opId.seq}`);
        expect(new Set(ids).size).toBe(ids.length);
        for (const e of entries) {
          expect(e.opId).toEqual({ replicaId: e.replicaId, seq: e.seq });
        }
      }),
    );
  });
});
