/**
 * [ADV] `restore` and `update-wins` as functions of the op set (task T5.3, D6, R6.9, R15.9).
 * Explicit causal models plus order-independence properties; the default (no `deletes` options)
 * must keep the 0.1.0 results exactly.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue, VersionVector } from '../../src/contracts/json.js';
import type { Op } from '../../src/contracts/op.js';
import type { CollectionDefinition } from '../../src/contracts/schema.js';
import { buildOp, serializeOp, verifyOpLine } from '../../src/ops/op.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { conflictHistory, deriveRecord } from '../../src/state/index.js';
import { effectiveDeletes, isDeleted, uncancelledDeletes } from '../../src/state/restore.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccc';

const fields = { v: f.string(), n: f.number({ resolver: 'max' }) };
const plain = defineCollection({ name: 'items', version: 1, fields });
const restorable = defineCollection({
  name: 'items',
  version: 1,
  fields,
  deletes: { restore: true },
});
const updateWins = defineCollection({
  name: 'items',
  version: 1,
  fields,
  deletes: { policy: 'update-wins' },
});
const both = defineCollection({
  name: 'items',
  version: 1,
  fields,
  deletes: { policy: 'update-wins', restore: true },
});

async function op(
  writer: string,
  seq: number,
  lamport: number,
  context: VersionVector,
  kind: 'set' | 'delete' | 'restore' = 'set',
  values: Record<string, JsonValue> = {},
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
      fields: values,
    })
  ).op;
}

const derive = (ops: Op[], d: CollectionDefinition) => deriveRecord(ops, d, 'items', 'r');

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

describe('restore ops are structurally valid (D6, design 4)', () => {
  it('a restore op has empty fields and verifies; one with fields is rejected', async () => {
    const r = await op(A, 1, 1, {}, 'restore', { v: 'ignored' });
    expect(r.fields).toEqual({});
    expect(await verifyOpLine(serializeOp(r))).toEqual(r);
    await expect(
      buildOp({
        replicaId: A,
        vector: {},
        maxLamport: 0,
        collection: 'items',
        recordId: 'r',
        kind: 'restore',
        schemaVersion: 1,
        fields: {},
      }).then(({ line }) => verifyOpLine(line.replace('"fields":{}', '"fields":{"v":"x"}'))),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('defineCollection deletes options (R6.9)', () => {
  it('accepts and freezes valid options; absent stays absent', () => {
    expect(plain.deletes).toBeUndefined();
    expect('deletes' in plain).toBe(false);
    expect(both.deletes).toEqual({ policy: 'update-wins', restore: true });
    expect(Object.isFrozen(both.deletes)).toBe(true);
  });

  it('rejects unknown policies, keys and types', () => {
    const bad: unknown[] = [{ policy: 'last-wins' }, { restore: 'yes' }, { extra: true }, null, []];
    for (const deletes of bad) {
      expect(() =>
        defineCollection({ name: 'x', version: 1, fields, deletes: deletes as never }),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error);
    }
  });
});

describe('restore (D6)', () => {
  it('a restore after a delete brings the record back with its old fields', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one', n: 1 });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const a3 = await op(A, 3, 3, {}, 'restore');
    const before = await derive([a1, a2], restorable);
    expect(before.deleted).toBe(true);
    const after = await derive([a1, a2, a3], restorable);
    expect(after.deleted).toBe(false);
    expect(after.fields['v']?.value).toBe('one');
    expect(after.fields['n']?.value).toBe(1);
  });

  it('a restore concurrent with a delete does not cancel that delete', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const b1 = await op(B, 1, 3, { [A]: 2 }, 'restore'); // after a2
    const c1 = await op(C, 1, 2, { [A]: 1 }, 'delete'); // concurrent with b1
    const r = await derive([a1, a2, b1, c1], restorable);
    expect(r.deleted).toBe(true);
    expect(uncancelledDeletes([a1, a2, b1, c1], restorable).map((o) => o.replicaId)).toEqual([C]);
    // A collection without restore ignores restore ops entirely (the engine never accepts them).
    expect(uncancelledDeletes([a1, a2, b1, c1], plain)).toHaveLength(2);
    // A later restore that saw both deletes brings it back.
    const b2 = await op(B, 2, 4, { [A]: 2, [C]: 1 }, 'restore');
    expect((await derive([a1, a2, b1, c1, b2], restorable)).deleted).toBe(false);
  });

  it('a delete after a restore deletes again', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const a3 = await op(A, 3, 3, {}, 'restore');
    const a4 = await op(A, 4, 4, {}, 'delete');
    expect((await derive([a1, a2, a3, a4], restorable)).deleted).toBe(true);
  });

  it('a cancelled delete no longer makes a current delete conflict; history keeps it', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const b1 = await op(B, 1, 2, { [A]: 1 }, 'set', { v: 'two' }); // concurrent with a2
    const withoutRestore = await derive([a1, a2, b1], restorable);
    expect(withoutRestore.conflicts.map((c) => c.kind)).toEqual(['delete']);
    const a3 = await op(A, 3, 3, { [B]: 1 }, 'restore');
    const all = [a1, a2, b1, a3];
    const r = await derive(all, restorable);
    expect(r.deleted).toBe(false);
    expect(r.fields['v']?.value).toBe('two');
    expect(r.conflicts).toEqual([]);
    const h = await conflictHistory(all, restorable, 'items', 'r');
    expect(h.map((c) => [c.kind, c.status])).toEqual([['delete', 'superseded']]);
  });
});

describe('update-wins (D6)', () => {
  it('a set concurrent with a delete keeps the record live', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const b1 = await op(B, 1, 2, { [A]: 1 }, 'set', { v: 'two' });
    const ops = [a1, a2, b1];
    expect((await derive(ops, plain)).deleted).toBe(true); // 0.1.0: delete wins
    const r = await derive(ops, updateWins);
    expect(r.deleted).toBe(false);
    expect(r.fields['v']?.value).toBe('two');
    expect(effectiveDeletes(ops, updateWins)).toEqual([]);
    // The concurrency is still reported as a delete conflict.
    expect(r.conflicts.map((c) => c.kind)).toEqual(['delete']);
  });

  it('a delete that saw every set still deletes', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const b1 = await op(B, 1, 2, { [A]: 1 }, 'set', { v: 'two' });
    const a2 = await op(A, 2, 3, { [B]: 1 }, 'delete');
    expect((await derive([a1, b1, a2], updateWins)).deleted).toBe(true);
  });

  it('one delete without a concurrent set is enough to delete', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const b1 = await op(B, 1, 2, { [A]: 1 }, 'set', { v: 'two' }); // concurrent with a2
    const c1 = await op(C, 1, 3, { [A]: 2, [B]: 1 }, 'delete'); // saw everything
    expect(isDeleted([a1, a2, b1, c1], updateWins)).toBe(true);
  });

  it('restore and update-wins combine', async () => {
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const a3 = await op(A, 3, 3, {}, 'restore');
    expect(isDeleted([a1, a2, a3], both)).toBe(false);
    expect(isDeleted([a1, a2], both)).toBe(true);
  });
});

describe('0.1.0 behaviour is unchanged by default (R6.7)', () => {
  it('without deletes options every delete wins, and results equal the explicit delete-wins', async () => {
    const explicit = defineCollection({
      name: 'items',
      version: 1,
      fields,
      deletes: { policy: 'delete-wins' },
    });
    const a1 = await op(A, 1, 1, {}, 'set', { v: 'one' });
    const a2 = await op(A, 2, 2, {}, 'delete');
    const b1 = await op(B, 1, 2, { [A]: 1 }, 'set', { v: 'two' });
    const ops = [a1, a2, b1];
    const r = await derive(ops, plain);
    expect(r.deleted).toBe(true);
    expect(r.fields).toEqual({});
    expect(await derive(ops, explicit)).toEqual(r);
    expect(await derive(ops, restorable)).toEqual(r);
  });
});

/**
 * A random causal history of one record over three writers: each step picks a writer, a kind and
 * which of the other writers' ops it has seen, so concurrency, cancellation and update-wins all
 * occur. Each op is built from the writer's view, like a real replica.
 */
interface Step {
  readonly writer: string;
  readonly kind: 'set' | 'delete' | 'restore';
  readonly seeA: boolean;
  readonly seeB: boolean;
  readonly seeC: boolean;
  readonly v: string;
  readonly n: number;
}

const historyArb: fc.Arbitrary<Step[]> = fc.array(
  fc.record({
    writer: fc.constantFrom(A, B, C),
    kind: fc.constantFrom<'set' | 'delete' | 'restore'>('set', 'set', 'delete', 'restore'),
    seeA: fc.boolean(),
    seeB: fc.boolean(),
    seeC: fc.boolean(),
    v: fc.string({ maxLength: 3 }),
    n: fc.integer({ min: 0, max: 9 }),
  }),
  { minLength: 1, maxLength: 9 },
);

async function build(steps: readonly Step[]): Promise<Op[]> {
  const all: Op[] = [];
  const view: Record<string, VersionVector> = { [A]: {}, [B]: {}, [C]: {} };
  const own: Record<string, number> = { [A]: 0, [B]: 0, [C]: 0 };
  for (const s of steps) {
    // Monotone and causally closed views: seeing a writer's latest op means seeing its view too.
    const ctx: Record<string, number> = { ...view[s.writer] };
    const see: Record<string, boolean> = { [A]: s.seeA, [B]: s.seeB, [C]: s.seeC };
    for (const w of [A, B, C]) {
      if (w === s.writer || !see[w]!) continue;
      for (const [x, n] of Object.entries(view[w]!)) ctx[x] = Math.max(ctx[x] ?? 0, n);
    }
    ctx[s.writer] = own[s.writer]!;
    const seen = all.filter((o) => (ctx[o.replicaId] ?? 0) >= o.seq);
    const maxLamport = seen.reduce((m, o) => Math.max(m, o.lamport), 0);
    const { op: built } = await buildOp({
      replicaId: s.writer,
      vector: Object.fromEntries(Object.entries(ctx).filter(([, n]) => n > 0)),
      maxLamport,
      collection: 'items',
      recordId: 'r',
      kind: s.kind,
      schemaVersion: 1,
      fields: s.kind === 'set' ? { v: s.v, n: s.n } : {},
    });
    all.push(built);
    own[s.writer] = built.seq;
    view[s.writer] = { ...ctx, [s.writer]: built.seq };
  }
  return all;
}

describe('order independence and convergence (R15.9)', () => {
  for (const [name, definition] of [
    ['delete-wins', plain],
    ['restore', restorable],
    ['update-wins', updateWins],
    ['update-wins + restore', both],
  ] as const) {
    it(`${name}: every arrival order derives the same record and conflict history`, async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (steps) => {
          const ops = await build(steps);
          const reference = await derive(ops, definition);
          const refHistory = await conflictHistory(ops, definition, 'items', 'r');
          for (const order of shuffles(ops, 6)) {
            expect(await derive(order, definition)).toEqual(reference);
            expect(await conflictHistory(order, definition, 'items', 'r')).toEqual(refHistory);
          }
        }),
        { numRuns: 60, seed: 53 },
      );
    });
  }

  it('without restore ops, restore-enabled collections derive exactly as 0.1.0', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (steps) => {
        const ops = await build(
          steps.map((s) => ({ ...s, kind: s.kind === 'restore' ? 'set' : s.kind })),
        );
        expect(await derive(ops, restorable)).toEqual(await derive(ops, plain));
      }),
      { numRuns: 60, seed: 54 },
    );
  });

  it('the deleted flag matches the D6 definition computed directly', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (steps) => {
        const ops = await build(steps);
        const hb = (x: Op, y: Op) => x !== y && (y.context[x.replicaId] ?? 0) >= x.seq;
        const conc = (x: Op, y: Op) => x !== y && !hb(x, y) && !hb(y, x);
        const dels = ops.filter((o) => o.kind === 'delete');
        const live = dels.filter((d) => !ops.some((r) => r.kind === 'restore' && hb(d, r)));
        const uw = live.filter((d) => !ops.some((s) => s.kind === 'set' && conc(d, s)));
        expect((await derive(ops, restorable)).deleted).toBe(live.length > 0);
        expect((await derive(ops, both)).deleted).toBe(uw.length > 0);
        expect((await derive(ops, plain)).deleted).toBe(dels.length > 0);
      }),
      { numRuns: 80, seed: 55 },
    );
  });
});
