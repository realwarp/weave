/**
 * [ADV] Held newer-schema ops (task T5.5, R8.7): with `holdNewerSchema`, a replica stores ops it
 * cannot read, excludes them from visible state, reports that an update is needed, and applies
 * them after the upgrade with equal hashes. Off by default (the prefix rule of R4.10 applies).
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { CompactionOptions, Replica } from '../../src/contracts/replica.js';
import type { CollectionDefinition } from '../../src/contracts/schema.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

const notesV1 = defineCollection({
  name: 'notes',
  version: 1,
  fields: { title: f.string({ required: true }), place: f.string() },
});
const notesV2 = defineCollection({
  name: 'notes',
  version: 2,
  fields: { title: f.string({ required: true }), site: f.string(), zone: f.string() },
  migrations: {
    1: ({ fields }) => {
      const { place, ...rest } = fields as { place?: string };
      if (place === undefined) return rest;
      const [site = '', zone = ''] = place.split('/');
      return { ...rest, site, zone };
    },
  },
});
const tasks = defineCollection({ name: 'tasks', version: 1, fields: { text: f.string() } });

let seed = 0;
async function open(
  collections: CollectionDefinition[],
  options: {
    backing?: MemoryBacking;
    hold?: boolean;
    compaction?: CompactionOptions;
    seed?: string;
  } = {},
): Promise<{ r: Replica; backing: MemoryBacking }> {
  const backing = options.backing ?? createMemoryBacking();
  const r = await createReplica({
    storage: memoryStorage({ backing }),
    collections,
    random: seededRandom(options.seed ?? `held-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(options.hold === true ? { holdNewerSchema: true } : {}),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
  });
  return { r, backing };
}
let m = 0;
const mid = () => `hm-${m++}`;

/**
 * A v2 writer with: a v1 record (readable by v1), that record updated at v2, a record created at
 * v2 only, and a record of a collection the old replica does not define.
 */
async function newerWriter() {
  const old = (await open([notesV1])).r;
  const { recordId: shared } = await old
    .collection(notesV1)
    .create({ title: 'old', place: 'a/b' }, { mutationId: mid() });
  const writer = (await open([notesV2, tasks])).r;
  expect((await writer.sync(old.endpoint())).status).toBe('complete');
  await writer.collection(notesV2).update(shared, { zone: 'z9' }, { mutationId: mid() });
  const { recordId: fresh } = await writer
    .collection(notesV2)
    .create({ title: 'v2 only', site: 's' }, { mutationId: mid() });
  const { recordId: task } = await writer
    .collection(tasks)
    .create({ text: 'new collection' }, { mutationId: mid() });
  return { writer, shared, fresh, task };
}

describe('off by default (R4.10 prefix rule)', () => {
  it('a v1 replica without the option blocks the origin and holds nothing', async () => {
    const { writer } = await newerWriter();
    const plain = (await open([notesV1])).r;
    const result = await plain.sync(writer.endpoint());
    expect(result.status).toBe('partial');
    expect(result.status === 'partial' ? result.code : undefined).toBe('PEER_SCHEMA_OLDER');
    expect((await plain.status()).held).toBeUndefined();
  });
});

describe('holding (R8.7)', () => {
  it('stores newer ops, excludes them from state, reports an update, and syncs complete', async () => {
    const { writer, shared, fresh, task } = await newerWriter();
    const { r: holder } = await open([notesV1], { hold: true });
    const result = await holder.sync(writer.endpoint());
    expect(result.status).toBe('complete');
    // Every op is held and acknowledged: equal vectors and op-set hashes.
    expect((await holder.status()).vector).toEqual((await writer.status()).vector);
    expect((await holder.hashes()).ops).toBe((await writer.hashes()).ops);
    // Visible state only from readable ops.
    const notes = holder.collection(notesV1);
    expect((await notes.get(shared))?.value).toEqual({ title: 'old', place: 'a/b' });
    expect(await notes.get(fresh)).toBeUndefined();
    expect((await notes.query()).map((x) => x.id)).toEqual([shared]);
    // The update-needed report.
    expect((await holder.status()).held).toEqual({ ops: 3, needs: { notes: 2, tasks: 1 } });
    // A local write over a held change would supersede it unseen: refused.
    await expect(notes.update(shared, { title: 'x' }, { mutationId: mid() })).rejects.toMatchObject(
      { code: 'SCHEMA_TOO_NEW' },
    );
    // A record that exists only through held ops: also "update the app first".
    await expect(notes.update(fresh, { title: 'x' }, { mutationId: mid() })).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
    void task;
  });

  it('applies held ops after the upgrade with equal hashes', async () => {
    const { writer, shared, fresh, task } = await newerWriter();
    const { r: holder, backing } = await open([notesV1], { hold: true, seed: 'up-1' });
    expect((await holder.sync(writer.endpoint())).status).toBe('complete');
    await holder.close();
    const upgraded = (await open([notesV2, tasks], { backing, hold: true, seed: 'up-2' })).r;
    expect((await upgraded.status()).held).toBeUndefined();
    expect(await upgraded.hashes()).toEqual(await writer.hashes());
    expect((await upgraded.collection(notesV2).get(shared))?.value).toEqual({
      title: 'old',
      site: 'a',
      zone: 'z9',
    });
    expect((await upgraded.collection(notesV2).get(fresh))?.value).toEqual({
      title: 'v2 only',
      site: 's',
    });
    expect((await upgraded.collection(tasks).get(task))?.value).toEqual({
      text: 'new collection',
    });
    // Writes work again and converge.
    await upgraded.collection(notesV2).update(shared, { site: 'b' }, { mutationId: mid() });
    expect((await upgraded.sync(writer.endpoint())).status).toBe('complete');
    expect(await upgraded.hashes()).toEqual(await writer.hashes());
  });

  it('an upgrade to v2 without the new collection keeps only that collection held', async () => {
    const { writer } = await newerWriter();
    const { r: holder, backing } = await open([notesV1], { hold: true, seed: 'part-1' });
    expect((await holder.sync(writer.endpoint())).status).toBe('complete');
    await holder.close();
    const partly = (await open([notesV2], { backing, hold: true, seed: 'part-2' })).r;
    expect((await partly.status()).held).toEqual({ ops: 1, needs: { tasks: 1 } });
  });

  it('a newer writer pushing into a holding endpoint also completes', async () => {
    const { writer } = await newerWriter();
    const { r: holder } = await open([notesV1], { hold: true });
    expect((await writer.sync(holder.endpoint())).status).toBe('complete');
    expect((await holder.hashes()).ops).toBe((await writer.hashes()).ops);
    expect((await holder.status()).held?.ops).toBe(3);
  });

  it('a holding replica forwards held ops to others (store and forward)', async () => {
    const { writer } = await newerWriter();
    const { r: holder } = await open([notesV1], { hold: true });
    expect((await holder.sync(writer.endpoint())).status).toBe('complete');
    const late = (await open([notesV2, tasks])).r;
    expect((await late.sync(holder.endpoint())).status).toBe('complete');
    expect(await late.hashes()).toEqual(await writer.hashes());
    // A non-holding v1 replica still gets only the readable prefix from the holder.
    const plain = (await open([notesV1])).r;
    const r = await plain.sync(holder.endpoint());
    expect(r.status === 'partial' && r.code).toBe('PEER_SCHEMA_OLDER');
  });

  it('a held op that arrives before its gap is buffered, then promoted', async () => {
    const { writer } = await newerWriter();
    const { r: holder } = await open([notesV1], { hold: true });
    const all = await writer.endpoint().pull({
      replicaId: holder.id,
      vector: {},
      support: {},
      limit: 100,
      hold: true,
    });
    expect(all.blocked).toEqual([]);
    const byOrigin = new Map<string, string[]>();
    for (const line of all.ops) {
      const origin = (JSON.parse(line) as { replicaId: string }).replicaId;
      byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), line]);
    }
    const writerLines = byOrigin.get(writer.id)!;
    expect(writerLines.length).toBe(3);
    const ep = holder.endpoint();
    // Other origins first, then the writer's ops in reverse order.
    for (const [origin, lines] of byOrigin)
      if (origin !== writer.id) await ep.push({ replicaId: origin, support: {}, ops: lines });
    await ep.push({ replicaId: writer.id, support: {}, ops: [writerLines[2]!] });
    expect((await holder.status()).pendingBuffer).toBe(1);
    await ep.push({ replicaId: writer.id, support: {}, ops: [writerLines[1]!] });
    await ep.push({ replicaId: writer.id, support: {}, ops: [writerLines[0]!] });
    expect((await holder.status()).pendingBuffer).toBe(0);
    expect((await holder.hashes()).ops).toBe((await writer.hashes()).ops);
    expect((await holder.status()).held?.ops).toBe(3);
  });

  it('snapshot bootstrap holds newer ops; without the option it is SCHEMA_TOO_NEW', async () => {
    const { writer } = await newerWriter();
    const snapshot = await writer.exportSnapshot();
    const strict = (await open([notesV1])).r;
    await expect(strict.bootstrap(snapshot)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    const { r: holder, backing } = await open([notesV1], { hold: true, seed: 'snap-1' });
    await holder.bootstrap(snapshot);
    expect((await holder.hashes()).ops).toBe((await writer.hashes()).ops);
    expect((await holder.status()).held).toEqual({ ops: 3, needs: { notes: 2, tasks: 1 } });
    await holder.close();
    const upgraded = (await open([notesV2, tasks], { backing, hold: true, seed: 'snap-2' })).r;
    expect(await upgraded.hashes()).toEqual(await writer.hashes());
  });

  it('compaction keeps every op of a record with held ops', async () => {
    const { writer, shared } = await newerWriter();
    const A = await open([notesV1], { hold: true, seed: 'cmp-a' });
    const aId = A.r.id;
    await A.r.close();
    const members = [aId, writer.id];
    const holder = (
      await open([notesV1], {
        backing: A.backing,
        hold: true,
        seed: 'cmp-a2',
        compaction: { enabled: true, members },
      })
    ).r;
    expect((await holder.sync(writer.endpoint())).status).toBe('complete');
    // The writer acknowledges everything the holder has, so the horizon covers every op.
    expect((await writer.sync(holder.endpoint())).status).toBe('complete');
    expect((await holder.sync(writer.endpoint())).status).toBe('complete');
    const before = (await holder.collection(notesV1).history(shared)).length;
    expect(before).toBe(2);
    const report = await holder.compact();
    expect(Object.keys(report.horizon)).toContain(writer.id);
    expect((await holder.collection(notesV1).history(shared)).length).toBe(before);
  });
});
