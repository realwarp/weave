/**
 * [ADV] Snapshot bootstrap on replicas (task T5.2, R4.8): a new replica bootstraps from a snapshot
 * with tombstones, then continues normal sync to equal hashes; integrity and safety checks.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { WeaveEvent } from '../../src/contracts/events.js';
import type { Replica } from '../../src/contracts/replica.js';
import type { Snapshot } from '../../src/contracts/sync.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { hashSnapshot } from '../../src/sync/snapshot.js';

const notesV1 = defineCollection({
  name: 'notes',
  version: 1,
  fields: { title: f.string({ required: true }), tags: f.set(f.string()) },
});
const notesV2 = defineCollection({
  name: 'notes',
  version: 2,
  fields: { title: f.string({ required: true }), tags: f.set(f.string()), pinned: f.boolean() },
  migrations: { 1: ({ fields }) => ({ ...fields }) },
});

let seed = 0;
async function open(
  options: {
    members?: string[];
    v2?: boolean;
    events?: WeaveEvent[];
    backing?: ReturnType<typeof createMemoryBacking>;
  } = {},
): Promise<Replica> {
  return createReplica({
    storage: memoryStorage({ backing: options.backing ?? createMemoryBacking() }),
    collections: [options.v2 === true ? notesV2 : notesV1],
    random: seededRandom(`snap-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(options.members === undefined
      ? {}
      : { compaction: { enabled: true, members: options.members } }),
    ...(options.events === undefined
      ? {}
      : { logger: (e: WeaveEvent) => void options.events!.push(e) }),
  });
}

const col = (r: Replica) => r.collection(notesV1);
let m = 0;
const mid = () => `s-${m++}`;

async function exchange(a: Replica, b: Replica): Promise<void> {
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
}

/** Two members of a closed set with a superseded history, a deleted record and a past conflict. */
async function compactedPair() {
  const backA = createMemoryBacking();
  const backB = createMemoryBacking();
  const ids = [(await open({ backing: backA })).id, (await open({ backing: backB })).id];
  backA.inUse = false;
  backB.inUse = false;
  const a = await open({ backing: backA, members: ids });
  const b = await open({ backing: backB, members: ids });
  const { recordId: kept } = await col(a).create(
    { title: 'v1', tags: ['x'] },
    { mutationId: mid() },
  );
  await exchange(a, b);
  await col(a).update(kept, { title: 'from a' }, { mutationId: mid() });
  await col(b).update(kept, { title: 'from b' }, { mutationId: mid() });
  await exchange(a, b);
  await col(a).update(kept, { title: 'settled' }, { mutationId: mid() });
  const { recordId: gone } = await col(b).create({ title: 'to delete' }, { mutationId: mid() });
  await col(b).delete(gone, { mutationId: mid() });
  await exchange(a, b);
  await exchange(a, b);
  expect((await a.compact()).removedOps).toBeGreaterThan(0);
  expect((await b.compact()).removedOps).toBeGreaterThan(0);
  return { a, b, kept, gone };
}

describe('snapshot bootstrap (R4.8)', () => {
  it('a new replica that needs compacted history bootstraps, then syncs to equal hashes', async () => {
    const { a, b, kept, gone } = await compactedPair();
    const events: WeaveEvent[] = [];
    const late = await open({ events });
    const refused = await late.sync(a.endpoint());
    expect(refused.status === 'failed' && refused.code).toBe('NEEDS_SNAPSHOT');

    const report = await late.bootstrap(a.endpoint());
    expect(report.source).toBe(a.id);
    expect(report.vector).toEqual((await a.status()).vector);
    expect(await late.hashes()).toEqual(await a.hashes());
    expect(await late.conflicts.history()).toEqual(await a.conflicts.history());
    expect((await col(late).get(kept))?.value.title).toBe('settled');
    expect(await col(late).get(gone)).toBeUndefined(); // tombstone kept: never resurrected
    expect(events.filter((e) => e.type === 'conflict.new')).toEqual([]); // old conflicts are not news

    // Normal sync continues in both directions.
    expect((await late.sync(a.endpoint())).status).toBe('complete');
    await col(late).update(kept, { title: 'from the newcomer' }, { mutationId: mid() });
    await exchange(late, a);
    await exchange(a, b);
    const h = await Promise.all([a, b, late].map((r) => r.hashes()));
    expect(h[0]!.state).toBe(h[1]!.state);
    expect(h[0]!.state).toBe(h[2]!.state);
    expect((await col(b).get(kept))?.value.title).toBe('from the newcomer');
  });

  it('bootstraps from a snapshot object and survives a restart', async () => {
    const { a } = await compactedPair();
    const snapshot = await a.exportSnapshot();
    const backing = createMemoryBacking();
    const late = await open({ backing });
    await late.bootstrap(snapshot);
    const hashes = await late.hashes();
    await late.close();
    const again = await open({ backing });
    expect(await again.hashes()).toEqual(hashes);
    expect((await again.status()).compaction?.compactedThrough).toEqual(
      (await a.status()).compaction?.compactedThrough,
    );
  });

  it('a replica that already holds data refuses to bootstrap', async () => {
    const { a } = await compactedPair();
    const busy = await open();
    await col(busy).create({ title: 'mine' }, { mutationId: mid() });
    const before = await busy.hashes();
    await expect(busy.bootstrap(a.endpoint())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await busy.hashes()).toEqual(before);
  });

  it('tampering is detected and nothing is written', async () => {
    const { a } = await compactedPair();
    const good = await a.exportSnapshot();
    const late = await open();
    const empty = await late.hashes();

    const badHash: Snapshot = {
      ...good,
      vector: { ...good.vector, [a.id]: (good.vector[a.id] ?? 0) + 1 },
    };
    await expect(late.bootstrap(badHash)).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });

    const editedOp = good.ops[0]!.replace('"title":"', '"title":"X');
    const resealed = async (s: Omit<Snapshot, 'hash'>): Promise<Snapshot> => ({
      ...s,
      hash: await hashSnapshot(s),
    });
    await expect(
      late.bootstrap(await resealed({ ...good, ops: [editedOp, ...good.ops.slice(1)] })),
    ).rejects.toBeTruthy();

    const missing = await resealed({ ...good, ops: good.ops.slice(0, -1) });
    await expect(late.bootstrap(missing)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await late.hashes()).toEqual(empty);
  });

  it('a snapshot that needs a newer schema is refused until the app upgrades', async () => {
    const source = await open({ v2: true });
    await source.collection(notesV2).create({ title: 'new', pinned: true }, { mutationId: mid() });
    const snapshot = await source.exportSnapshot();
    const old = await open();
    await expect(old.bootstrap(snapshot)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    const upgraded = await open({ v2: true });
    await upgraded.bootstrap(snapshot);
    expect(await upgraded.hashes()).toEqual(await source.hashes());
  });

  it('an endpoint without snapshots gives NOT_SUPPORTED', async () => {
    const a = await open();
    const late = await open();
    const { pull, push, ack } = a.endpoint();
    await expect(late.bootstrap({ pull, push, ack })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });
});
