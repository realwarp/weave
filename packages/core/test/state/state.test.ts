import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue, VersionVector } from '../../src/contracts/json.js';
import type { Op } from '../../src/contracts/op.js';
import { buildOp } from '../../src/ops/op.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { buildOpHistory, conflictHistory, deriveRecord } from '../../src/state/index.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccc';
const D = 'dddddddddddddddddddddddddd';

const items = defineCollection({
  name: 'items',
  version: 1,
  fields: { v: f.string(), n: f.number({ resolver: 'max' }), tags: f.set(f.string()) },
});

/** A tiny explicit causal model: each op is written with an explicit context. */
async function op(
  writer: string,
  seq: number,
  lamport: number,
  context: VersionVector,
  fields: Record<string, JsonValue>,
  kind: 'set' | 'delete' = 'set',
): Promise<Op> {
  const vector = { ...context, ...(seq > 1 ? { [writer]: seq - 1 } : {}) };
  return (
    await buildOp({
      replicaId: writer,
      vector,
      maxLamport: lamport - 1,
      collection: 'items',
      recordId: 'r',
      kind,
      schemaVersion: 1,
      fields,
    })
  ).op;
}

const derive = (ops: Op[]) => deriveRecord(ops, items, 'items', 'r');
const history = (ops: Op[]) => conflictHistory(ops, items, 'items', 'r');

function shuffles<T>(list: T[], n = 20): T[][] {
  const out: T[][] = [];
  for (let s = 1; s <= n; s++) {
    const copy = [...list];
    let x = s;
    for (let i = copy.length - 1; i > 0; i--) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const j = x % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    out.push(copy);
  }
  return out;
}

describe('deriveRecord (D5, D6)', () => {
  it('sequential edits: the last write wins with no conflict', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'one' });
    const b1 = await op(B, 1, 2, { [A]: 1 }, { v: 'two' });
    const r = await derive([a1, b1]);
    expect(r.fields['v']?.value).toBe('two');
    expect(r.conflicts).toEqual([]);
  });

  it('concurrent edits of one field: a conflict resolved by the field resolver', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'a', n: 3 });
    const b1 = await op(B, 1, 1, {}, { v: 'b', n: 9 });
    const r = await derive([a1, b1]);
    expect(r.fields['v']?.value).toBe('b');
    expect(r.fields['n']?.value).toBe(9);
    expect(r.conflicts.map((c) => c.field).sort()).toEqual(['n', 'v']);
  });

  it('a write after the whole frontier closes the conflict (R6.2)', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'a' });
    const b1 = await op(B, 1, 1, {}, { v: 'b' });
    const c1 = await op(C, 1, 2, { [A]: 1, [B]: 1 }, { v: 'c' });
    const r = await derive([a1, b1, c1]);
    expect(r.conflicts).toEqual([]);
    expect(r.fields['v']).toEqual({ value: 'c', frontier: [{ replicaId: C, seq: 1 }] });
    const log = await history([a1, b1, c1]);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('superseded');
    expect(r.conflictHistoryIds).toEqual([log[0]!.conflictId]);
  });

  it('non-transitive contexts: frontier computed from each context directly', async () => {
    // C saw A but not B; B saw nothing; A saw nothing.
    const a1 = await op(A, 1, 1, {}, { v: 'a' });
    const b1 = await op(B, 1, 1, {}, { v: 'b' });
    const c1 = await op(C, 1, 2, { [A]: 1 }, { v: 'c' });
    const r = await derive([a1, b1, c1]);
    expect(r.fields['v']?.frontier.map((o) => o.replicaId).sort()).toEqual([B, C]);
  });

  it('delete wins over a concurrent set and records a delete conflict', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'x' });
    const del = await op(A, 2, 2, {}, {}, 'delete');
    const edit = await op(B, 1, 2, { [A]: 1 }, { v: 'edit' });
    const r = await derive([a1, del, edit]);
    expect(r.deleted).toBe(true);
    expect(r.fields).toEqual({});
    expect(r.conflicts.map((c) => c.kind)).toEqual(['delete']);
  });

  it('equal op sets give equal records in any order (property)', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'a', tags: ['x'] });
    const b1 = await op(B, 1, 1, {}, { v: 'b', tags: ['y'], n: 1 });
    const a2 = await op(A, 2, 2, { [B]: 1 }, { n: 4 });
    const c1 = await op(C, 1, 2, { [A]: 1 }, { v: 'c' });
    const d1 = await op(D, 1, 3, { [A]: 2, [B]: 1 }, {}, 'delete');
    const all = [a1, b1, a2, c1, d1];
    const expected = JSON.stringify(await derive(all));
    const expectedHistory = JSON.stringify(await history(all));
    for (const order of shuffles(all)) {
      expect(JSON.stringify(await derive(order))).toBe(expected);
      expect(JSON.stringify(await history(order))).toBe(expectedHistory);
    }
  });
});

describe('operation history (R2.5)', () => {
  it('(a) sequential edits have no concurrent entries, in D4 order', async () => {
    const a1 = await op(A, 1, 1, {}, { v: '1' });
    const a2 = await op(A, 2, 2, {}, { v: '2' });
    const b1 = await op(B, 1, 3, { [A]: 2 }, { v: '3' });
    const h = buildOpHistory([b1, a2, a1]);
    expect(h.map((e) => `${e.opId.replicaId}:${e.opId.seq}`)).toEqual([
      `${A}:1`,
      `${A}:2`,
      `${B}:1`,
    ]);
    expect(h.every((e) => e.concurrentWith.length === 0)).toBe(true);
  });

  it('(b, c) concurrent and mixed histories, including the non-transitive case', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'a' });
    const b1 = await op(B, 1, 1, {}, { v: 'b' });
    const c1 = await op(C, 1, 2, { [A]: 1, [B]: 1 }, { v: 'c' });
    const d1 = await op(D, 1, 2, { [A]: 1, [B]: 1 }, { v: 'd' });
    const h = buildOpHistory([a1, b1, c1, d1]);
    const by = (r: string) =>
      h.find((e) => e.opId.replicaId === r)!.concurrentWith.map((o) => o.replicaId);
    expect(by(A)).toEqual([B]);
    expect(by(B)).toEqual([A]);
    expect(by(C)).toEqual([D]);
    expect(by(D)).toEqual([C]);
    // non-transitive: E saw only A, so it is concurrent with B even though B is before C
    const e1 = await op('eeeeeeeeeeeeeeeeeeeeeeeeee', 1, 2, { [A]: 1 }, { v: 'e' });
    const h2 = buildOpHistory([a1, b1, e1]);
    expect(h2.find((e) => e.opId.replicaId === B)!.concurrentWith.map((o) => o.replicaId)).toEqual([
      A,
      'eeeeeeeeeeeeeeeeeeeeeeeeee',
    ]);
  });

  it('(d) deleted records keep their history; (f) order-independent', async () => {
    const a1 = await op(A, 1, 1, {}, { v: 'a' });
    const del = await op(B, 1, 2, { [A]: 1 }, {}, 'delete');
    const h = buildOpHistory([del, a1]);
    expect(h.map((e) => e.kind)).toEqual(['set', 'delete']);
    expect(JSON.stringify(buildOpHistory([a1, del]))).toBe(JSON.stringify(h));
    expect(buildOpHistory([])).toEqual([]);
  });

  it('property: any order of the same ops gives the same history', async () => {
    const ops = [
      await op(A, 1, 1, {}, { v: 'a' }),
      await op(B, 1, 1, {}, { v: 'b' }),
      await op(A, 2, 2, { [B]: 1 }, { v: 'c' }),
      await op(C, 1, 2, {}, { v: 'd' }),
    ];
    const expected = JSON.stringify(buildOpHistory(ops));
    fc.assert(
      fc.property(
        fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }),
        (order) => {
          expect(JSON.stringify(buildOpHistory(order))).toBe(expected);
        },
      ),
    );
  });
});
