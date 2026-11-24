/**
 * [ADV] Counter resolver (task T5.4, R6.10, R6.6, R15.9): direct-call permutation tests of the
 * resolver and its merge, then counter fields through replicas (concurrent deltas all count).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { JsonValue } from '../../src/contracts/json.js';
import type { FrontierEntry } from '../../src/contracts/resolver.js';
import type { CompactionOptions, Replica } from '../../src/contracts/replica.js';
import { createReplica } from '../../src/engine/replica.js';
import { assertResolverDeterministic } from '../../src/resolvers/assert.js';
import {
  applyCounterDelta,
  counter,
  counterTotal,
  isCounterState,
  mergeCounterStates,
} from '../../src/resolvers/counter.js';
import { defineCollection, f, validateLocalWrite } from '../../src/schema/index.js';

const R = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccc',
];

function entry(i: number, value: JsonValue): FrontierEntry {
  const replicaId = R[i % 3]!;
  return { opId: { replicaId, seq: i + 1 }, lamport: i + 1, replicaId, seq: i + 1, value };
}

const arbState = fc
  .dictionary(
    fc.constantFrom(...R),
    fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 })),
    { maxKeys: 3 },
  )
  .map((d) => d as unknown as JsonValue);

describe('counter state helpers', () => {
  it('recognises well-formed states only', () => {
    expect(isCounterState({})).toBe(true);
    expect(isCounterState({ [R[0]!]: [1, 0] })).toBe(true);
    for (const bad of [
      null,
      [],
      5,
      { nope: [1, 0] },
      { [R[0]!]: [1] },
      { [R[0]!]: [-1, 0] },
      { [R[0]!]: [1.5, 0] },
      { [R[0]!]: ['1', 0] },
    ])
      expect(isCounterState(bad)).toBe(false);
  });

  it('applies positive and negative deltas to the writer only', () => {
    let s = applyCounterDelta({}, R[0]!, 3);
    s = applyCounterDelta(s, R[0]!, -1);
    s = applyCounterDelta(s, R[1]!, 5);
    expect(s).toEqual({ [R[0]!]: [3, 1], [R[1]!]: [5, 0] });
    expect(counterTotal(s)).toBe(7);
    expect(() => applyCounterDelta(s, R[0]!, 0.5)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
    );
    expect(() => applyCounterDelta(s, R[0]!, Number.MAX_SAFE_INTEGER)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
    );
  });

  it('merge is commutative, associative and idempotent', () => {
    fc.assert(
      fc.property(arbState, arbState, arbState, (a, b, c) => {
        const ab = mergeCounterStates([a, b]);
        expect(mergeCounterStates([b, a])).toEqual(ab);
        expect(mergeCounterStates([mergeCounterStates([a, b]), c])).toEqual(
          mergeCounterStates([a, mergeCounterStates([b, c])]),
        );
        expect(mergeCounterStates([a, a])).toEqual(mergeCounterStates([a]));
      }),
      { seed: 41, numRuns: 200 },
    );
  });
});

describe('counter resolver (direct calls, R6.6)', () => {
  it('sums per-replica deltas; concurrent states each count once', () => {
    const a = { [R[0]!]: [2, 0] };
    const b = { [R[1]!]: [1, 0] };
    const both = { [R[0]!]: [2, 0], [R[1]!]: [1, 0] };
    expect(counter([entry(0, a), entry(1, b)], {})).toBe(3);
    // A state that already includes another counts nothing twice.
    expect(counter([entry(0, a), entry(1, both)], {})).toBe(3);
    expect(counter([entry(0, { [R[0]!]: [5, 7] })], {})).toBe(-2);
  });

  it('every order of every frontier gives the same total (assertResolverDeterministic)', () => {
    fc.assert(
      fc.property(fc.array(arbState, { minLength: 1, maxLength: 7 }), (states) => {
        assertResolverDeterministic(counter, [states.map((s, i) => entry(i, s))], { orders: 60 });
      }),
      { seed: 42, numRuns: 80 },
    );
  });

  it('rejects an empty frontier and malformed values with RESOLVER_ERROR', () => {
    expect(() => counter([], {})).toThrow(
      expect.objectContaining({ code: 'RESOLVER_ERROR' }) as Error,
    );
    expect(() => counter([entry(0, 3)], {})).toThrow(
      expect.objectContaining({ code: 'RESOLVER_ERROR' }) as Error,
    );
  });
});

const posts = defineCollection({
  name: 'posts',
  version: 1,
  fields: { title: f.string({ required: true }), likes: f.counter() },
});

let seed = 0;
async function open(
  options: { backing?: MemoryBacking; compaction?: CompactionOptions } = {},
): Promise<{ r: Replica; backing: MemoryBacking }> {
  const backing = options.backing ?? createMemoryBacking();
  const r = await createReplica({
    storage: memoryStorage({ backing }),
    collections: [posts],
    random: seededRandom(`counter-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
  });
  return { r, backing };
}
const col = (r: Replica) => r.collection(posts);
let m = 0;
const mid = () => `cm-${m++}`;
async function exchange(a: Replica, b: Replica): Promise<void> {
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
}

describe('local write validation of counter deltas (review T5.4 F-f)', () => {
  it('validateLocalWrite itself rejects non-integer deltas, before the engine merges', () => {
    expect(validateLocalWrite(posts, 'update', { likes: -3 })).toEqual({ likes: -3 });
    for (const bad of [0.5, '1', null, true, { n: 1 }])
      expect(() => validateLocalWrite(posts, 'update', { likes: bad })).toThrow(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: expect.stringContaining('safe integer delta') as string,
        }) as Error,
      );
  });
});

describe('counter fields through replicas (R6.10, R15.9)', () => {
  it('writes take deltas, reads give totals, and a retry adds nothing', async () => {
    const { r } = await open();
    const { recordId } = await col(r).create({ title: 'p', likes: 2 }, { mutationId: mid() });
    expect((await col(r).get(recordId))?.value).toEqual({ title: 'p', likes: 2 });
    const once = mid();
    await col(r).update(recordId, { likes: 1 }, { mutationId: once });
    const again = await col(r).update(recordId, { likes: 1 }, { mutationId: once });
    expect(again.replayed).toBe(true);
    await col(r).update(recordId, { likes: -4 }, { mutationId: mid() });
    expect((await col(r).get(recordId))?.value.likes).toBe(-1);
    for (const bad of [0.5, '1', null, true, { n: 1 }]) {
      await expect(
        col(r).update(recordId, { likes: bad as number }, { mutationId: mid() }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('concurrent deltas from three replicas all count, in any sync order', async () => {
    const reps = [(await open()).r, (await open()).r, (await open()).r];
    const { recordId } = await col(reps[0]!).create({ title: 'p' }, { mutationId: mid() });
    await exchange(reps[0]!, reps[1]!);
    await exchange(reps[0]!, reps[2]!);
    // Each replica adds concurrently, some of them twice.
    await col(reps[0]!).update(recordId, { likes: 1 }, { mutationId: mid() });
    await col(reps[1]!).update(recordId, { likes: 1 }, { mutationId: mid() });
    await col(reps[1]!).update(recordId, { likes: 1 }, { mutationId: mid() });
    await col(reps[2]!).update(recordId, { likes: 5 }, { mutationId: mid() });
    await exchange(reps[2]!, reps[1]!);
    await col(reps[1]!).update(recordId, { likes: -1 }, { mutationId: mid() }); // saw 2 and 5
    await exchange(reps[0]!, reps[1]!);
    await exchange(reps[0]!, reps[2]!);
    await exchange(reps[1]!, reps[2]!);
    for (const r of reps) expect((await col(r).get(recordId))?.value.likes).toBe(7);
    const hashes = await Promise.all(reps.map((r) => r.hashes()));
    expect(new Set(hashes.map((h) => JSON.stringify(h))).size).toBe(1);
  });

  it('a peer whose op carries a malformed counter state is rejected (A2)', async () => {
    const { r } = await open();
    const other = await open();
    const { recordId } = await col(other.r).create({ title: 'p' }, { mutationId: mid() });
    await exchange(r, other.r);
    // A counter field written as a plain number by a faulty peer fails the stored-form check.
    const bad = defineCollection({
      name: 'posts',
      version: 1,
      fields: { title: f.string({ required: true }), likes: f.number() },
    });
    const faulty = await createReplica({
      storage: memoryStorage({ backing: createMemoryBacking() }),
      collections: [bad],
      random: seededRandom('faulty'),
      clock: fakeClock(),
      scheduler: fakeScheduler(),
    });
    expect((await faulty.sync(r.endpoint())).status).toBe('complete');
    await faulty.collection(bad).update(recordId, { likes: 3 }, { mutationId: mid() });
    const result = await faulty.sync(r.endpoint());
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.code : undefined).toBe('VALIDATION_FAILED');
    expect((await col(r).get(recordId))?.value).toEqual({ title: 'p' });
  });

  it('compaction keeps the full count (R3.13)', async () => {
    const A = await open();
    const B = await open();
    const members = [A.r.id, B.r.id];
    await A.r.close();
    await B.r.close();
    const a = (await open({ backing: A.backing, compaction: { enabled: true, members } })).r;
    const b = (await open({ backing: B.backing, compaction: { enabled: true, members } })).r;
    const { recordId } = await col(a).create({ title: 'p', likes: 1 }, { mutationId: mid() });
    await exchange(a, b);
    for (let i = 0; i < 3; i++) await col(a).update(recordId, { likes: 1 }, { mutationId: mid() });
    await col(b).update(recordId, { likes: 10 }, { mutationId: mid() });
    await exchange(a, b);
    await exchange(a, b);
    expect((await a.compact()).removedOps).toBeGreaterThan(0);
    expect((await col(a).get(recordId))?.value.likes).toBe(14);
    await col(a).update(recordId, { likes: 1 }, { mutationId: mid() });
    await exchange(a, b);
    for (const r of [a, b]) expect((await col(r).get(recordId))?.value.likes).toBe(15);
  });
});
