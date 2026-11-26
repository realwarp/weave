/**
 * [ADV] Snapshot verification scales linearly with a single origin's history (PR #2 review, F5).
 * Instead of timing, the test counts array-iterator steps during `verifySnapshotEnvelope`: a
 * copy of the per-origin list for every op makes that count grow with the square of the op count,
 * a linear check makes it grow in proportion. Doubling the ops must not much more than double it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeOps } from '../../../testing/src/transport/conformance.js';
import { sealSnapshot, verifySnapshotEnvelope } from '../../src/sync/snapshot.js';

const ORIGIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const original = Array.prototype[Symbol.iterator];

afterEach(() => {
  Array.prototype[Symbol.iterator] = original;
});

async function snapshotOf(n: number) {
  const ops = await makeOps(ORIGIN, n);
  return sealSnapshot({
    format: 'weave-snapshot/1',
    source: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
    vector: { [ORIGIN]: n },
    maxLamport: n,
    compactedThrough: {},
    removed: {},
    ops,
    archives: [],
  });
}

/** Array-iterator `next` calls made while verifying `snapshot`. */
async function iteratorSteps(snapshot: unknown): Promise<number> {
  let steps = 0;
  Array.prototype[Symbol.iterator] = function counted(this: unknown[]) {
    const it = original.call(this);
    return {
      next: () => {
        steps++;
        return it.next();
      },
      [Symbol.iterator]() {
        return this;
      },
    } as unknown as ArrayIterator<unknown>;
  } as typeof original;
  try {
    const { ops } = await verifySnapshotEnvelope(snapshot);
    Array.prototype[Symbol.iterator] = original;
    expect(ops).toHaveLength((snapshot as { ops: unknown[] }).ops.length);
  } finally {
    Array.prototype[Symbol.iterator] = original;
  }
  return steps;
}

describe('snapshot verification of a large single-origin history (F5)', () => {
  it('doubling the ops of one origin about doubles the work, not quadruples it', async () => {
    const small = await snapshotOf(1_000);
    const large = await snapshotOf(2_000);
    const a = await iteratorSteps(small);
    const b = await iteratorSteps(large);
    expect(b / a).toBeLessThan(2.5);
  }, 120_000);

  it('a missing seq in a large single-origin snapshot is still found', async () => {
    const snapshot = await snapshotOf(1_000);
    const holed = await sealSnapshot({
      ...snapshot,
      ops: snapshot.ops.filter((_, i) => i !== 500),
    });
    await expect(verifySnapshotEnvelope(holed)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { opId: `${ORIGIN}:501` },
    });
  }, 120_000);
});
