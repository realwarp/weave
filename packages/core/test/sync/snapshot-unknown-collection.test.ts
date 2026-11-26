/**
 * [ADV] Snapshot import treats a collection the replica does not define like normal sync does
 * (PR #2 review, F6). R4.10: "a collection the receiver does not define counts as unsupported",
 * and "an op it cannot read is rejected with `SCHEMA_TOO_NEW`". R8.7: only a replica that holds
 * (`holdNewerSchema: true`) stores such ops instead, as held ops.
 */
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { Replica } from '../../src/contracts/replica.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });
const tasks = defineCollection({ name: 'tasks', version: 1, fields: { done: f.boolean() } });

let seed = 0;
const open = (collections: Parameters<typeof createReplica>[0]['collections'], hold = false) =>
  createReplica({
    storage: memoryStorage(),
    collections,
    random: seededRandom(`snap-unknown-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(hold ? { holdNewerSchema: true } : {}),
  });

async function sourceSnapshot(): Promise<{ source: Replica; snapshot: unknown }> {
  const source = await open([notes, tasks]);
  await source.collection(notes).create({ title: 'n' }, { mutationId: 'su-1' });
  await source.collection(tasks).create({ done: true }, { mutationId: 'su-2' });
  return { source, snapshot: await source.exportSnapshot() };
}

describe('snapshot ops of a collection the replica does not define (F6)', () => {
  it('without holding: refused with SCHEMA_TOO_NEW, nothing stored', async () => {
    const { source, snapshot } = await sourceSnapshot();
    const target = await open([notes]);
    await expect(target.bootstrap(snapshot as never)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
      details: { collection: 'tasks' },
    });
    const s = await target.status();
    expect(s.vector).toEqual({});
    expect(s.vector[source.id]).toBeUndefined();
  });

  it('normal sync refuses the same op the same way (the boundary being matched)', async () => {
    const { source } = await sourceSnapshot();
    const target = await open([notes]);
    const res = await target.sync(source.endpoint());
    expect(res.status).toBe('partial');
    expect(res.status === 'partial' && res.code).toBe('PEER_SCHEMA_OLDER');
  });

  it('with holding: stored and held, as R8.7 allows', async () => {
    const { source, snapshot } = await sourceSnapshot();
    const target = await open([notes], true);
    await target.bootstrap(snapshot as never);
    const s = await target.status();
    expect(s.vector[source.id]).toBe(2);
    expect(s.held).toMatchObject({ ops: 1 });
  });
});
