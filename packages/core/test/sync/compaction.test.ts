/**
 * [ADV] Replica-side compaction (task T5.1, R3.6 to R3.10, R3.13, R15.9). Closed replica sets and
 * relay-published horizons; offline, never-acknowledging and removed members; NEEDS_SNAPSHOT; no
 * resurrection of deleted records.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { CompactionOptions, Replica } from '../../src/contracts/replica.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    n: f.number({ resolver: 'max' }),
    tags: f.set(f.string()),
  },
});

let seed = 0;
async function open(
  options: { compaction?: CompactionOptions; backing?: MemoryBacking; seed?: string } = {},
): Promise<{ r: Replica; backing: MemoryBacking }> {
  const backing = options.backing ?? createMemoryBacking();
  const r = await createReplica({
    storage: memoryStorage({ backing }),
    collections: [notes],
    random: seededRandom(options.seed ?? `compaction-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
  });
  return { r, backing };
}

const col = (r: Replica) => r.collection(notes);
let m = 0;
const mid = () => `m-${m++}`;

/** Full exchange so that each side acknowledges the other (push records the pusher's ack). */
async function exchange(a: Replica, b: Replica): Promise<void> {
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
}

/** Ops this replica still holds, counted through each record's operation history. */
async function countOps(r: Replica): Promise<number> {
  const all = await col(r).query({ includeDeleted: true });
  let n = 0;
  for (const rec of all) n += (await col(r).history(rec.id)).length;
  return n;
}

describe('compaction is off by default (R3.12)', () => {
  it('compact() throws NOT_SUPPORTED without the option, and nothing changes', async () => {
    const { r } = await open();
    await col(r).create({ title: 'a' }, { mutationId: mid() });
    await expect(r.compact()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('enabled but no horizon known: NOT_SUPPORTED', async () => {
    const { r } = await open({ compaction: { enabled: true } });
    await expect(r.compact()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('closed replica set (R3.6, R3.7, R3.8)', () => {
  async function pair() {
    const ids = { a: '', b: '' };
    const A = await open({ seed: 'set-a' });
    const B = await open({ seed: 'set-b' });
    ids.a = A.r.id;
    ids.b = B.r.id;
    await A.r.close();
    await B.r.close();
    const members = [ids.a, ids.b];
    const a = (
      await open({ backing: A.backing, seed: 'set-a2', compaction: { enabled: true, members } })
    ).r;
    const b = (
      await open({ backing: B.backing, seed: 'set-b2', compaction: { enabled: true, members } })
    ).r;
    return { a, b };
  }

  it('discards superseded ops covered by every member; state, frontier and conflicts unchanged', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'v1', n: 1 }, { mutationId: mid() });
    for (let i = 2; i <= 5; i++)
      await col(a).update(recordId, { title: `v${i}`, n: i }, { mutationId: mid() });
    await exchange(a, b);
    const before = await a.hashes();
    const value = (await col(a).get(recordId))?.value;
    const report = await a.compact();
    expect(report.removedOps).toBe(4); // v1..v4 are superseded in every field; v5 is the frontier
    expect((await a.hashes()).state).toBe(before.state);
    expect((await a.hashes()).conflicts).toBe(before.conflicts);
    expect((await col(a).get(recordId))?.value).toEqual(value);
    expect(await countOps(a)).toBe(1);
    expect(report.compactedThrough[a.id]).toBe(4);
    // A rebuild from the remaining ops gives the same state.
    await a.rebuild();
    expect((await a.hashes()).state).toBe(before.state);
    // The other member compacts to the same horizon and holds the same op set.
    await b.compact();
    expect(await b.hashes()).toEqual(await a.hashes());
  });

  it('a member that never acknowledged counts as zero: nothing is discarded (R3.7)', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'x' }, { mutationId: mid() });
    await col(a).update(recordId, { title: 'y' }, { mutationId: mid() });
    void b; // b is offline and never synced
    expect((await a.compact()).removedOps).toBe(0);
    expect(await countOps(a)).toBe(2);
  });

  it('an older acknowledgement holds the horizon at that point (offline member)', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'x' }, { mutationId: mid() });
    await col(a).update(recordId, { title: 'y' }, { mutationId: mid() });
    await exchange(a, b); // b acknowledges seq 1..2
    await col(a).update(recordId, { title: 'z' }, { mutationId: mid() });
    await col(a).update(recordId, { title: 'w' }, { mutationId: mid() });
    // b goes offline: its ack stays at 2. Seq 1 and 2 are covered and superseded; 3 and 4 are not
    // covered, so they stay even though 3 is superseded too.
    const report = await a.compact();
    expect(report.horizon[a.id]).toBe(2);
    expect(report.removedOps).toBe(2);
    expect(await countOps(a)).toBe(2);
    expect((await col(a).history(recordId)).map((h) => h.fields['title'])).toEqual(['z', 'w']);
  });

  it('concurrent edits: the open conflict and its frontier ops stay', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'base' }, { mutationId: mid() });
    await exchange(a, b);
    await col(a).update(recordId, { title: 'from a' }, { mutationId: mid() });
    await col(b).update(recordId, { title: 'from b' }, { mutationId: mid() });
    await exchange(a, b);
    await exchange(a, b);
    const conflicts = await a.conflicts.current();
    expect(conflicts).toHaveLength(1);
    const report = await a.compact();
    expect(report.removedOps).toBe(1); // only 'base'
    expect(await a.conflicts.current()).toEqual(conflicts);
  });

  it('deleted records keep a compact tombstone; a late peer cannot resurrect them (R3.13)', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'doomed' }, { mutationId: mid() });
    await col(a).update(recordId, { title: 'still doomed' }, { mutationId: mid() });
    await col(a).delete(recordId, { mutationId: mid() });
    // Delete not yet covered: full tombstone, nothing goes.
    expect((await a.compact()).removedOps).toBe(0);
    await exchange(a, b);
    const report = await a.compact();
    expect(report.removedOps).toBe(2);
    const history = await col(a).history(recordId);
    expect(history.map((h) => h.kind)).toEqual(['delete']);
    expect(await col(a).get(recordId)).toBeUndefined();
    expect((await col(a).query({ includeDeleted: true })).map((x) => x.id)).toEqual([recordId]);
    // b (which holds every op) syncs again: the record stays deleted on both sides.
    await exchange(a, b);
    expect(await col(b).get(recordId)).toBeUndefined();
    expect(await col(a).get(recordId)).toBeUndefined();
  });

  it('conflict history survives compaction and is never announced twice', async () => {
    const { a, b } = await pair();
    const { recordId } = await col(a).create({ title: 'base' }, { mutationId: mid() });
    await exchange(a, b);
    await col(a).update(recordId, { title: 'A' }, { mutationId: mid() });
    await col(b).update(recordId, { title: 'B' }, { mutationId: mid() });
    await exchange(a, b);
    await col(a).update(recordId, { title: 'merged' }, { mutationId: mid() }); // supersedes it
    await exchange(a, b);
    await exchange(a, b);
    const history = await a.conflicts.history();
    expect(history.map((c) => c.status)).toEqual(['superseded']);
    const report = await a.compact();
    expect(report.removedOps).toBeGreaterThan(0);
    expect((await a.conflicts.history()).map((c) => c.conflictId)).toEqual(
      history.map((c) => c.conflictId),
    );
    expect(await a.conflicts.current()).toEqual([]);
  });
});

describe('serving compacted history (R3.9)', () => {
  it('a peer that needs discarded ops gets NEEDS_SNAPSHOT, never partial history', async () => {
    const A = await open({ seed: 'serve-a' });
    const B = await open({ seed: 'serve-b' });
    const members = [A.r.id, B.r.id];
    await A.r.close();
    await B.r.close();
    const a = (await open({ backing: A.backing, compaction: { enabled: true, members } })).r;
    const b = (await open({ backing: B.backing, compaction: { enabled: true, members } })).r;
    const { recordId } = await col(a).create({ title: '1' }, { mutationId: mid() });
    await col(a).update(recordId, { title: '2' }, { mutationId: mid() });
    await exchange(a, b);
    expect((await a.compact()).removedOps).toBe(1);
    const newcomer = (await open({ seed: 'serve-new' })).r;
    const res = await newcomer.sync(a.endpoint());
    expect(res.status).toBe('failed');
    expect(res.status === 'failed' && res.code).toBe('NEEDS_SNAPSHOT');
    expect(await col(newcomer).query({ includeDeleted: true })).toEqual([]);
    // A peer that already holds the history syncs normally.
    expect((await b.sync(a.endpoint())).status).toBe('complete');
  });
});

describe('removePeer (R3.10)', () => {
  it('a removed member leaves the horizon and its later ops are refused', async () => {
    const A = await open({ seed: 'rm-a' });
    const B = await open({ seed: 'rm-b' });
    const C = await open({ seed: 'rm-c' });
    const members = [A.r.id, B.r.id, C.r.id];
    for (const x of [A, B, C]) await x.r.close();
    const a = (await open({ backing: A.backing, compaction: { enabled: true, members } })).r;
    const b = (await open({ backing: B.backing, compaction: { enabled: true, members } })).r;
    const c = (await open({ backing: C.backing, compaction: { enabled: true, members } })).r;
    const { recordId } = await col(a).create({ title: '1' }, { mutationId: mid() });
    await col(a).update(recordId, { title: '2' }, { mutationId: mid() });
    await exchange(a, b);
    // c never acknowledged: nothing can go.
    expect((await a.compact()).removedOps).toBe(0);
    await a.removePeer(c.id);
    expect((await a.status()).compaction?.removed[c.id]).toBe(0);
    expect((await a.compact()).removedOps).toBe(1);
    // c writes and tries to deliver: refused, nothing from c stored.
    await col(c).create({ title: 'from removed' }, { mutationId: mid() });
    const lines = (
      await c.endpoint().pull({ replicaId: a.id, vector: {}, support: { notes: 1 }, limit: 100 })
    ).ops;
    const before = await a.hashes();
    await expect(
      a.endpoint().push({ replicaId: c.id, support: { notes: 1 }, ops: lines }),
    ).rejects.toMatchObject({
      code: 'PEER_REMOVED',
    });
    expect((await a.status()).vector[c.id]).toBeUndefined();
    expect(await a.hashes()).toEqual(before);
    // Through sync, c (which never received the compacted history) is told it needs a snapshot.
    const res = await c.sync(a.endpoint());
    expect(res.status === 'failed' && res.code).toBe('NEEDS_SNAPSHOT');
    await expect(a.removePeer(a.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('compaction state survives a restart', () => {
  it('compactedThrough and the removed list are durable', async () => {
    const A = await open({ seed: 'dur-a' });
    const B = await open({ seed: 'dur-b' });
    const members = [A.r.id, B.r.id];
    await A.r.close();
    await B.r.close();
    let a = (await open({ backing: A.backing, compaction: { enabled: true, members } })).r;
    const b = (await open({ backing: B.backing, compaction: { enabled: true, members } })).r;
    const { recordId } = await col(a).create({ title: '1' }, { mutationId: mid() });
    await col(a).update(recordId, { title: '2' }, { mutationId: mid() });
    await exchange(a, b);
    await a.compact();
    const status = await a.status();
    const hashes = await a.hashes();
    await a.close();
    a = (await open({ backing: A.backing, compaction: { enabled: true, members } })).r;
    expect((await a.status()).compaction).toEqual(status.compaction);
    expect(await a.hashes()).toEqual(hashes);
  });
});
