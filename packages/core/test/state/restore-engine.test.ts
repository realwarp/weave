/**
 * [ADV] `restore` and `update-wins` through the replica API (task T5.3, R6.8, R6.9, D6, R15.9):
 * local writes, sync convergence, rejection when the feature is off, compaction and snapshots.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { ChangeEvent, CompactionOptions, Replica } from '../../src/contracts/replica.js';
import type { CollectionDefinition } from '../../src/contracts/schema.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

const fields = { title: f.string({ required: true }), n: f.number({ resolver: 'max' }) };
const plain = defineCollection({ name: 'notes', version: 1, fields });
const restorable = defineCollection({
  name: 'notes',
  version: 1,
  fields,
  deletes: { restore: true },
});
const updateWins = defineCollection({
  name: 'notes',
  version: 1,
  fields,
  deletes: { policy: 'update-wins' },
});

let seed = 0;
async function open(
  definition: CollectionDefinition,
  options: { compaction?: CompactionOptions; backing?: MemoryBacking; seed?: string } = {},
): Promise<{ r: Replica; backing: MemoryBacking }> {
  const backing = options.backing ?? createMemoryBacking();
  const r = await createReplica({
    storage: memoryStorage({ backing }),
    collections: [definition],
    random: seededRandom(options.seed ?? `restore-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
  });
  return { r, backing };
}

const col = (r: Replica, d: CollectionDefinition = restorable) =>
  r.collection(d as typeof restorable);
let m = 0;
const mid = () => `rm-${m++}`;

async function exchange(a: Replica, b: Replica): Promise<void> {
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
}

describe('restore is off by default (R6.9, requirements 1.3)', () => {
  it('restore() on a collection without deletes.restore throws NOT_SUPPORTED and writes nothing', async () => {
    const { r } = await open(plain);
    const c = col(r, plain);
    const { recordId } = await c.create({ title: 'a' }, { mutationId: mid() });
    await c.delete(recordId, { mutationId: mid() });
    const before = await c.history(recordId);
    await expect(c.restore(recordId, { mutationId: mid() })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
    expect(await c.history(recordId)).toEqual(before);
    expect(await c.get(recordId)).toBeUndefined();
  });

  it('a peer without restore rejects restore ops with NOT_SUPPORTED and keeps its state', async () => {
    const a = (await open(restorable)).r;
    const b = (await open(plain)).r;
    const { recordId } = await col(a).create({ title: 'x' }, { mutationId: mid() });
    await col(a).delete(recordId, { mutationId: mid() });
    await exchange(a, b);
    await col(a).restore(recordId, { mutationId: mid() });
    const result = await a.sync(b.endpoint());
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.code : undefined).toBe('NOT_SUPPORTED');
    expect(await col(b, plain).get(recordId)).toBeUndefined();
    expect((await col(b, plain).history(recordId)).map((h) => h.kind)).toEqual(['set', 'delete']);
  });
});

describe('local restore (D6, R6.8)', () => {
  it('undeletes with the old values, emits a restore change, and is idempotent per mutationId', async () => {
    const { r } = await open(restorable);
    const c = col(r);
    const changes: ChangeEvent[] = [];
    r.subscribe((e) => changes.push(e));
    const { recordId } = await c.create({ title: 'keep', n: 4 }, { mutationId: mid() });
    await expect(c.restore(recordId, { mutationId: mid() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await c.delete(recordId, { mutationId: mid() });
    await expect(c.update(recordId, { n: 5 }, { mutationId: mid() })).rejects.toMatchObject({
      code: 'RECORD_DELETED',
    });
    const restoreId = mid();
    const first = await c.restore(recordId, { mutationId: restoreId });
    expect(first.replayed).toBe(false);
    expect((await c.get(recordId))?.value).toEqual({ title: 'keep', n: 4 });
    const again = await c.restore(recordId, { mutationId: restoreId });
    expect(again).toEqual({ ...first, replayed: true });
    expect(changes.map((e) => e.kind)).toEqual(['set', 'delete', 'restore']);
    // A restored record accepts writes again, and can be deleted and restored again.
    await c.update(recordId, { n: 6 }, { mutationId: mid() });
    await c.delete(recordId, { mutationId: mid() });
    await c.restore(recordId, { mutationId: mid() });
    expect((await c.get(recordId))?.value).toEqual({ title: 'keep', n: 6 });
    expect((await c.history(recordId)).map((h) => h.kind)).toEqual([
      'set',
      'delete',
      'restore',
      'set',
      'delete',
      'restore',
    ]);
  });

  it('restore of an unknown record is VALIDATION_FAILED', async () => {
    const { r } = await open(restorable);
    await expect(col(r).restore('nope', { mutationId: mid() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('survives a restart', async () => {
    const backing = createMemoryBacking();
    const first = (await open(restorable, { backing, seed: 'restart' })).r;
    const { recordId } = await col(first).create({ title: 'r' }, { mutationId: mid() });
    await col(first).delete(recordId, { mutationId: mid() });
    await col(first).restore(recordId, { mutationId: mid() });
    await first.close();
    const second = (await open(restorable, { backing, seed: 'restart-2' })).r;
    expect((await col(second).get(recordId))?.value).toEqual({ title: 'r' });
  });
});

describe('convergence across replicas (R15.9)', () => {
  it('a restore concurrent with a new delete does not cancel it, on every replica', async () => {
    const a = (await open(restorable)).r;
    const b = (await open(restorable)).r;
    const c = (await open(restorable)).r;
    const { recordId } = await col(a).create({ title: 'x' }, { mutationId: mid() });
    await col(a).delete(recordId, { mutationId: mid() });
    await exchange(a, b);
    await exchange(a, c);
    // b restores (it saw a's delete); c restores first, then deletes again, concurrently with b.
    await col(b).restore(recordId, { mutationId: mid() });
    await col(c).restore(recordId, { mutationId: mid() });
    await col(c).delete(recordId, { mutationId: mid() });
    await exchange(b, c);
    await exchange(a, b);
    await exchange(a, c);
    for (const r of [a, b, c]) expect(await col(r).get(recordId)).toBeUndefined();
    const hashes = await Promise.all([a, b, c].map((r) => r.hashes()));
    expect(new Set(hashes.map((h) => JSON.stringify(h))).size).toBe(1);
    // A restore that saw both deletes brings it back everywhere.
    await col(a).restore(recordId, { mutationId: mid() });
    await exchange(a, b);
    await exchange(a, c);
    for (const r of [a, b, c]) expect((await col(r).get(recordId))?.value).toEqual({ title: 'x' });
  });

  it('update-wins: a concurrent update keeps the record live on both sides', async () => {
    const a = (await open(updateWins)).r;
    const b = (await open(updateWins)).r;
    const { recordId } = await col(a, updateWins).create({ title: 'x' }, { mutationId: mid() });
    await exchange(a, b);
    await col(a, updateWins).delete(recordId, { mutationId: mid() });
    await col(b, updateWins).update(recordId, { title: 'edited' }, { mutationId: mid() });
    await exchange(a, b);
    for (const r of [a, b]) {
      const view = await col(r, updateWins).get(recordId);
      expect(view?.value).toEqual({ title: 'edited' });
      expect(view?.conflicts.map((x) => x.kind)).toEqual(['delete']);
    }
    // The record is live, so a writer that saw the ignored delete may still update it.
    await col(a, updateWins).update(recordId, { n: 1 }, { mutationId: mid() });
    await exchange(a, b);
    expect((await col(b, updateWins).get(recordId))?.value).toEqual({ title: 'edited', n: 1 });
    // A delete that saw every update deletes it.
    await col(b, updateWins).delete(recordId, { mutationId: mid() });
    await exchange(a, b);
    for (const r of [a, b]) expect(await col(r, updateWins).get(recordId)).toBeUndefined();
  });

  it('the same op set under delete-wins (default) deletes the record', async () => {
    const a = (await open(plain)).r;
    const b = (await open(plain)).r;
    const { recordId } = await col(a, plain).create({ title: 'x' }, { mutationId: mid() });
    await exchange(a, b);
    await col(a, plain).delete(recordId, { mutationId: mid() });
    await col(b, plain).update(recordId, { title: 'edited' }, { mutationId: mid() });
    await exchange(a, b);
    for (const r of [a, b]) expect(await col(r, plain).get(recordId)).toBeUndefined();
  });
});

describe('compaction and snapshots keep restore safe (R3.13, R4.8)', () => {
  async function pair(definition: CollectionDefinition) {
    const A = await open(definition, { seed: `cp-a-${seed}` });
    const B = await open(definition, { seed: `cp-b-${seed++}` });
    const members = [A.r.id, B.r.id];
    await A.r.close();
    await B.r.close();
    const compaction = { enabled: true, members };
    const a = (await open(definition, { backing: A.backing, compaction })).r;
    const b = (await open(definition, { backing: B.backing, compaction })).r;
    return { a, b };
  }

  for (const [name, definition] of [
    ['restore', restorable],
    ['update-wins', updateWins],
  ] as const) {
    it(`${name}: a deleted record keeps every op (no compact tombstone)`, async () => {
      const { a, b } = await pair(definition);
      const c = col(a, definition);
      const { recordId } = await c.create({ title: 'old' }, { mutationId: mid() });
      await c.update(recordId, { title: 'newer' }, { mutationId: mid() });
      await c.delete(recordId, { mutationId: mid() });
      await exchange(a, b);
      await a.compact();
      expect((await c.history(recordId)).map((h) => h.kind)).toEqual(['set', 'set', 'delete']);
      if (definition === restorable) {
        await c.restore(recordId, { mutationId: mid() });
        await exchange(a, b);
        for (const r of [a, b])
          expect((await col(r, definition).get(recordId))?.value).toEqual({ title: 'newer' });
      }
    });
  }

  it('a live restored record still compacts its superseded ops', async () => {
    const { a, b } = await pair(restorable);
    const c = col(a);
    const { recordId } = await c.create({ title: 'one' }, { mutationId: mid() });
    await c.delete(recordId, { mutationId: mid() });
    await c.restore(recordId, { mutationId: mid() });
    await c.update(recordId, { title: 'two' }, { mutationId: mid() });
    await exchange(a, b);
    const report = await a.compact();
    expect(report.removedOps).toBe(3);
    expect((await c.get(recordId))?.value).toEqual({ title: 'two' });
    await exchange(a, b);
    expect((await col(b).get(recordId))?.value).toEqual({ title: 'two' });
  });

  it('snapshots carry restore ops; a replica without restore refuses them', async () => {
    const a = (await open(restorable)).r;
    const { recordId } = await col(a).create({ title: 's' }, { mutationId: mid() });
    await col(a).delete(recordId, { mutationId: mid() });
    await col(a).restore(recordId, { mutationId: mid() });
    const snapshot = await a.exportSnapshot();
    const late = (await open(restorable)).r;
    await late.bootstrap(snapshot);
    expect((await col(late).get(recordId))?.value).toEqual({ title: 's' });
    const old = (await open(plain)).r;
    await expect(old.bootstrap(snapshot)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});
