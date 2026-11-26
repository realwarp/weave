/**
 * [ADV] Custom resolvers and `assertResolverDeterministic` (task T5.4, R6.10, R6.6, R15.9): the
 * helper accepts pure, order-independent resolvers and rejects position-dependent, stateful,
 * input-mutating and failing ones; custom fields resolve the same on every replica.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { JsonValue } from '../../src/contracts/json.js';
import type { FrontierEntry, Resolver } from '../../src/contracts/resolver.js';
import type { Replica } from '../../src/contracts/replica.js';
import type { CollectionDefinition } from '../../src/contracts/schema.js';
import { createReplica } from '../../src/engine/replica.js';
import * as api from '../../src/index.js';
import { assertResolverDeterministic } from '../../src/resolvers/assert.js';
import { defineResolver } from '../../src/resolvers/custom.js';
import { defineCollection, f } from '../../src/schema/index.js';

function entry<V extends JsonValue>(i: number, value: V, replica = 'r'): FrontierEntry<V> {
  const replicaId = `${replica}${i}`;
  return { opId: { replicaId, seq: 1 }, lamport: 1 + (i % 2), replicaId, seq: 1, value };
}
const sample = <V extends JsonValue>(values: V[]) => values.map((v, i) => entry(i, v));

/** Longest string wins; ties go to the smaller string. Pure and order-independent. */
const longest = defineResolver<string>('longest', (entries) =>
  entries
    .map((e) => e.value)
    .reduce((best, v) =>
      v.length > best.length || (v.length === best.length && v < best) ? v : best,
    ),
);

const expectError = (fn: () => unknown, code: string) =>
  expect(fn).toThrow(expect.objectContaining({ code }) as Error);

describe('defineResolver', () => {
  it('is exported from the public API with assertResolverDeterministic', () => {
    expect(api.defineResolver).toBe(defineResolver);
    expect(api.assertResolverDeterministic).toBe(assertResolverDeterministic);
  });

  it('validates the name and function and freezes the result', () => {
    expect(Object.isFrozen(longest)).toBe(true);
    for (const name of ['', 'Upper', '1abc', 'a'.repeat(65), 'has space'])
      expectError(() => defineResolver(name, (e) => e[0]!.value), 'VALIDATION_FAILED');
    expectError(() => defineResolver('ok', 5 as unknown as Resolver), 'VALIDATION_FAILED');
  });
});

describe('assertResolverDeterministic (R6.6)', () => {
  it('accepts pure order-independent resolvers, including every built-in shape', () => {
    assertResolverDeterministic(longest, [
      sample(['a', 'bb', 'cc', 'd']),
      sample(['x']),
      sample(['same', 'same', 'zzzz', 'aaaa', 'q', 'rr', 'sss', 'tttt']),
    ]);
    const sum: Resolver = (entries) => entries.reduce((s, e) => s + (e.value as number), 0);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -99, max: 99 }), { minLength: 1, maxLength: 8 }),
        (ns) => assertResolverDeterministic(sum, [sample(ns)], { orders: 40 }),
      ),
      { seed: 43, numRuns: 60 },
    );
  });

  it('rejects a position-dependent resolver', () => {
    const first: Resolver = (entries) => entries[0]!.value;
    expectError(() => assertResolverDeterministic(first, [sample(['a', 'b'])]), 'RESOLVER_ERROR');
    // Also in the seeded-orders path for large samples.
    const big = sample(Array.from({ length: 9 }, (_, i) => `v${i}`));
    expectError(() => assertResolverDeterministic(first, [big]), 'RESOLVER_ERROR');
  });

  it('rejects a stateful resolver even on a one-entry sample', () => {
    let calls = 0;
    const stateful: Resolver = () => calls++;
    expectError(() => assertResolverDeterministic(stateful, [sample(['a'])]), 'RESOLVER_ERROR');
  });

  it('rejects a resolver that mutates its input', () => {
    const sorting: Resolver = (entries) =>
      (entries as FrontierEntry[]).sort((a, b) => (a.value as number) - (b.value as number))[0]!
        .value;
    expectError(() => assertResolverDeterministic(sorting, [sample([3, 1, 2])]), 'RESOLVER_ERROR');
  });

  it('rejects a resolver that throws, returns an unsupported value, or has no samples', () => {
    const throws: Resolver = () => {
      throw new Error('boom');
    };
    expectError(() => assertResolverDeterministic(throws, [sample(['a'])]), 'RESOLVER_ERROR');
    const undef = (() => undefined) as unknown as Resolver;
    expectError(() => assertResolverDeterministic(undef, [sample(['a'])]), 'RESOLVER_ERROR');
    expectError(() => assertResolverDeterministic(longest, []), 'VALIDATION_FAILED');
  });

  it('names the resolver and the disagreeing order in the error', () => {
    const first = defineResolver('first', (entries) => entries[0]!.value);
    try {
      assertResolverDeterministic(first, [sample(['a', 'b'])]);
      throw new Error('expected a failure');
    } catch (e) {
      expect((e as Error).message).toContain('"first"');
      expect((e as { details: { order: string[] } }).details.order).toHaveLength(2);
    }
  });
});

const docs = defineCollection({
  name: 'docs',
  version: 1,
  fields: { title: f.custom(f.string({ required: true }), longest), n: f.number() },
});

let seed = 0;
const open = (definition: CollectionDefinition = docs): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [definition],
    random: seededRandom(`custom-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
let m = 0;
const mid = () => `cu-${m++}`;
async function exchange(a: Replica, b: Replica): Promise<void> {
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
}

describe('custom fields through replicas (R6.10)', () => {
  it('f.custom keeps the base type check and required flag', () => {
    const field = docs.fields.title;
    expect(field.resolver).toBe('custom');
    expect(field.custom?.name).toBe('longest');
    expect(field.required).toBe(true);
    expect(field.validate('x')).toBe(true);
    expect(field.validate(1)).toBe(false);
    expectError(() => f.custom(f.counter(), longest as never), 'VALIDATION_FAILED');
    expectError(
      () => f.custom(f.string(), { name: 'x', resolve: 1 } as never),
      'VALIDATION_FAILED',
    );
  });

  it('concurrent values resolve with the custom resolver on every replica', async () => {
    const a = await open();
    const b = await open();
    const { recordId } = await a.collection(docs).create({ title: 't' }, { mutationId: mid() });
    await exchange(a, b);
    await a.collection(docs).update(recordId, { title: 'short' }, { mutationId: mid() });
    await b.collection(docs).update(recordId, { title: 'much longer' }, { mutationId: mid() });
    await exchange(a, b);
    for (const r of [a, b]) {
      const view = await r.collection(docs).get(recordId);
      expect(view?.value.title).toBe('much longer');
      expect(view?.conflicts.map((x) => x.field)).toEqual(['title']);
    }
  });

  it('a resolver result of the wrong type is RESOLVER_ERROR and changes nothing', async () => {
    // Fine for one value, wrong type once two values conflict.
    const bad = defineResolver('bad', (e) => (e.length > 1 ? 42 : e[0]!.value));
    const badDocs = defineCollection({
      name: 'docs',
      version: 1,
      fields: { title: f.custom(f.string(), bad as never) },
    });
    const a = await open(badDocs);
    const b = await open(badDocs);
    const { recordId } = await a.collection(badDocs).create({ title: 'x' }, { mutationId: mid() });
    await exchange(a, b);
    await a.collection(badDocs).update(recordId, { title: 'y' }, { mutationId: mid() });
    await b.collection(badDocs).update(recordId, { title: 'z' }, { mutationId: mid() });
    const result = await a.sync(b.endpoint());
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.code : undefined).toBe('RESOLVER_ERROR');
    expect((await a.collection(badDocs).get(recordId))?.value.title).toBe('y');
  });
});
