import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WeaveError } from '../../src/contracts/errors.js';
import type { JsonValue } from '../../src/contracts/json.js';
import type { FrontierEntry, ResolverContext, ResolverName } from '../../src/contracts/resolver.js';
import { RESOLVER_NAMES, getResolver, resolveField } from '../../src/resolvers/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('../canonical/vectors.json', import.meta.url), 'utf8'),
) as { setUnion: Array<{ name: string; inputJson: string; expectedJson: string }> };

function entry(lamport: number, replicaId: string, seq: number, value: JsonValue): FrontierEntry {
  return { opId: { replicaId, seq }, lamport, replicaId, seq, value };
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i]!, ...p];
  }
}

function d4(a: FrontierEntry, b: FrontierEntry): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
  return a.seq - b.seq;
}

/** Adversarial orders: reverse D4 and interleaved by replica. */
function adversarial(entries: readonly FrontierEntry[]): FrontierEntry[][] {
  const sorted = [...entries].sort(d4);
  const byReplica = new Map<string, FrontierEntry[]>();
  for (const e of sorted) byReplica.set(e.replicaId, [...(byReplica.get(e.replicaId) ?? []), e]);
  const interleaved: FrontierEntry[] = [];
  const lists = [...byReplica.values()];
  for (let i = 0; interleaved.length < sorted.length; i++) {
    for (const l of lists) if (l[i] !== undefined) interleaved.push(l[i]!);
  }
  return [sorted, [...sorted].reverse(), interleaved];
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Calls the resolver DIRECTLY on every ordering (no engine sorting). */
function expectOrderIndependent(
  name: ResolverName,
  entries: readonly FrontierEntry[],
  context: ResolverContext = {},
): JsonValue {
  const resolver = getResolver(name);
  const expected = JSON.stringify(resolver(entries, context));
  const orders =
    entries.length <= 6
      ? [...permutations(entries)]
      : Array.from({ length: 50 }, (_, i) => shuffle(entries, i + 1));
  for (const order of [...orders, ...adversarial(entries)]) {
    expect(JSON.stringify(resolver(order, context))).toBe(expected);
  }
  return JSON.parse(expected) as JsonValue;
}

function expectResolverError(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect((e as WeaveError).code).toBe('RESOLVER_ERROR');
    return;
  }
  throw new Error('expected RESOLVER_ERROR');
}

const arbReplica = fc.constantFrom('a', 'b', 'c', 'd', '\ue000', '\ud800\udc00');
const arbEntries = <V extends JsonValue>(value: fc.Arbitrary<V>) =>
  fc
    .uniqueArray(
      fc.record({
        lamport: fc.integer({ min: 1, max: 5 }),
        replicaId: arbReplica,
        seq: fc.integer({ min: 1, max: 4 }),
        value,
      }),
      { minLength: 1, maxLength: 9, selector: (e) => `${e.replicaId}:${e.seq}` },
    )
    .map((list) => list.map((e) => entry(e.lamport, e.replicaId, e.seq, e.value)));

describe('built-in resolvers', () => {
  it('lists every MVP resolver plus the [ADV] counter (0.2.0, T5.4)', () => {
    expect([...RESOLVER_NAMES].sort()).toEqual([
      'counter',
      'last-writer-wins',
      'max',
      'max-rank',
      'min',
      'set-union',
    ]);
  });

  it('last-writer-wins picks the greatest (lamport, replicaId by UTF-8, seq)', () => {
    expect(resolveField('last-writer-wins', [entry(1, 'b', 1, 'x'), entry(2, 'a', 1, 'y')])).toBe(
      'y',
    );
    expect(resolveField('last-writer-wins', [entry(2, 'b', 1, 'b'), entry(2, 'a', 9, 'a')])).toBe(
      'b',
    );
    expect(
      resolveField('last-writer-wins', [entry(2, 'a', 1, 'one'), entry(2, 'a', 2, 'two')]),
    ).toBe('two');
    // UTF-8 order: U+10000 is greater than U+E000 (the UTF-16 sort would say the opposite)
    expect(
      resolveField('last-writer-wins', [
        entry(3, '\ud800\udc00', 1, 'astral'),
        entry(3, '\ue000', 1, 'bmp'),
      ]),
    ).toBe('astral');
  });

  it('max and min compare numbers numerically and strings by UTF-8 bytes', () => {
    expect(resolveField('max', [entry(1, 'a', 1, 2), entry(1, 'b', 1, 10)])).toBe(10);
    expect(resolveField('min', [entry(1, 'a', 1, 2), entry(1, 'b', 1, 10)])).toBe(2);
    expect(
      resolveField('max', [entry(1, 'a', 1, '\ue000'), entry(1, 'b', 1, '\ud800\udc00')]),
    ).toBe('\ud800\udc00');
    expectResolverError(() => resolveField('max', [entry(1, 'a', 1, 1), entry(1, 'b', 1, '1')]));
    expectResolverError(() => resolveField('min', [entry(1, 'a', 1, true)]));
  });

  it('max-rank returns the most advanced value of the rank map', () => {
    const rankMap = ['open', 'in_review', 'closed'];
    const entries = [
      entry(1, 'a', 1, 'open'),
      entry(1, 'b', 1, 'closed'),
      entry(1, 'c', 1, 'in_review'),
    ];
    expect(expectOrderIndependent('max-rank', entries, { rankMap })).toBe('closed');
    expectResolverError(() => resolveField('max-rank', [entry(1, 'a', 1, 'lost')], { rankMap }));
    expectResolverError(() => resolveField('max-rank', [entry(1, 'a', 1, 'open')]));
  });

  it('set-union follows the vectors file (dedupe by encoding, UTF-8 byte order)', () => {
    for (const v of vectors.setUnion) {
      const input = JSON.parse(v.inputJson) as JsonValue[];
      const entries = input.map((item, i) => entry(1, `r${i}`, 1, [item]));
      expect(JSON.stringify(expectOrderIndependent('set-union', entries))).toBe(
        JSON.stringify(JSON.parse(v.expectedJson)),
      );
    }
    expectResolverError(() => resolveField('set-union', [entry(1, 'a', 1, 'not an array')]));
  });

  it('every resolver rejects an empty frontier', () => {
    for (const name of RESOLVER_NAMES)
      expectResolverError(() => resolveField(name, [], { rankMap: ['x'] }));
  });
});

describe('resolver determinism properties (R6.6, R15.3)', () => {
  it('last-writer-wins', () => {
    fc.assert(
      fc.property(
        arbEntries(fc.string()),
        (e) => void expectOrderIndependent('last-writer-wins', e),
      ),
      { numRuns: 60 },
    );
  });
  it('max and min on numbers', () => {
    fc.assert(
      fc.property(arbEntries(fc.integer()), (e) => {
        expectOrderIndependent('max', e);
        expectOrderIndependent('min', e);
      }),
      { numRuns: 60 },
    );
  });
  it('max and min on strings', () => {
    fc.assert(
      fc.property(arbEntries(fc.string({ unit: 'grapheme' })), (e) => {
        expectOrderIndependent('max', e);
        expectOrderIndependent('min', e);
      }),
      { numRuns: 60 },
    );
  });
  it('set-union, including duplicates and mixed element types', () => {
    const element = fc.oneof(
      fc.integer({ min: -3, max: 3 }),
      fc.constantFrom('a', 'b', '3', '\ue000'),
      fc.boolean(),
      fc.constant(null),
    );
    fc.assert(
      fc.property(
        arbEntries(fc.array(element, { maxLength: 4 })),
        (e) => void expectOrderIndependent('set-union', e),
      ),
      { numRuns: 60 },
    );
  });
  it('max-rank with random rank maps', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 })
          .chain((rankMap) =>
            fc.tuple(fc.constant(rankMap), arbEntries(fc.constantFrom(...rankMap))),
          ),
        ([rankMap, e]) => void expectOrderIndependent('max-rank', e, { rankMap }),
      ),
      { numRuns: 60 },
    );
  });
});
