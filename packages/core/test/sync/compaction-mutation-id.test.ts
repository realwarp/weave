/**
 * [ADV] Write idempotency survives compaction (PR #2 review, F7; R5.4). Compaction may discard
 * an op, but the `mut/<mutationId>` record that maps the ID to its result (`payloadHash`, `opId`,
 * `recordId`) is kept, so a retry of an already stored mutation is still recognized: identical
 * payload returns the original result marked `replayed`, a different payload fails with
 * `MUTATION_ID_REUSED`, and neither writes anything.
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
  fields: { title: f.string({ required: true }) },
});

async function open(
  backing: MemoryBacking,
  seed: string,
  compaction?: CompactionOptions,
): Promise<Replica> {
  return createReplica({
    storage: memoryStorage({ backing }),
    collections: [notes],
    random: seededRandom(seed),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(compaction === undefined ? {} : { compaction }),
  });
}

/** Two members that have exchanged everything, reopened with compaction over the closed set. */
async function compactedPair() {
  const backA = createMemoryBacking();
  const backB = createMemoryBacking();
  const a0 = await open(backA, 'mid-a');
  const b0 = await open(backB, 'mid-b');
  const members = [a0.id, b0.id];
  await a0.close();
  await b0.close();
  const a = await open(backA, 'mid-a2', { enabled: true, members });
  const b = await open(backB, 'mid-b2', { enabled: true, members });

  const col = a.collection(notes);
  const created = await col.create({ title: 'v1' }, { mutationId: 'mid-create' });
  const first = await col.update(created.recordId, { title: 'v2' }, { mutationId: 'mid-u1' });
  await col.update(created.recordId, { title: 'v3' }, { mutationId: 'mid-u2' });
  expect((await a.sync(b.endpoint())).status).toBe('complete');
  expect((await b.sync(a.endpoint())).status).toBe('complete');
  const report = await a.compact();
  return { a, b, backA, members, created, first, report };
}

/** The op count, commit counter and state the retry must leave untouched. */
async function fingerprint(r: Replica) {
  const s = await r.status();
  const recs = await r.collection(notes).query({ includeDeleted: true });
  let ops = 0;
  for (const rec of recs) ops += (await r.collection(notes).history(rec.id)).length;
  return { vector: s.vector, hashes: await r.hashes(), ops };
}

describe('mutation IDs stay recognized after compaction (F7, R5.4)', () => {
  it('compaction removed the ops of the earlier writes', async () => {
    const { report, a, created } = await compactedPair();
    expect(report.removedOps).toBe(2); // v1 and v2 are superseded by v3
    expect((await a.collection(notes).history(created.recordId)).length).toBe(1);
  });

  it('a retry of a compacted create returns the original result, replayed, and writes nothing', async () => {
    const { a, created } = await compactedPair();
    const before = await fingerprint(a);
    const retry = await a.collection(notes).create({ title: 'v1' }, { mutationId: 'mid-create' });
    expect(retry).toEqual({ recordId: created.recordId, opId: created.opId, replayed: true });
    expect(await fingerprint(a)).toEqual(before);
  });

  it('a retry of a compacted update returns the original result, replayed', async () => {
    const { a, created, first } = await compactedPair();
    const before = await fingerprint(a);
    const retry = await a
      .collection(notes)
      .update(created.recordId, { title: 'v2' }, { mutationId: 'mid-u1' });
    expect(retry).toEqual({ recordId: created.recordId, opId: first.opId, replayed: true });
    expect(await fingerprint(a)).toEqual(before);
  });

  it('the same ID with a different payload fails with MUTATION_ID_REUSED and writes nothing', async () => {
    const { a } = await compactedPair();
    const before = await fingerprint(a);
    await expect(
      a.collection(notes).create({ title: 'something else' }, { mutationId: 'mid-create' }),
    ).rejects.toMatchObject({ code: 'MUTATION_ID_REUSED' });
    expect(await fingerprint(a)).toEqual(before);
  });

  it('the retained record survives closing and reopening the replica', async () => {
    const { a, backA, members, created } = await compactedPair();
    await a.close();
    const reopened = await open(backA, 'mid-a3', { enabled: true, members });
    const before = await fingerprint(reopened);
    const retry = await reopened
      .collection(notes)
      .create({ title: 'v1' }, { mutationId: 'mid-create' });
    expect(retry).toEqual({ recordId: created.recordId, opId: created.opId, replayed: true });
    await expect(
      reopened.collection(notes).create({ title: 'x' }, { mutationId: 'mid-create' }),
    ).rejects.toMatchObject({ code: 'MUTATION_ID_REUSED' });
    expect(await fingerprint(reopened)).toEqual(before);
  });

  it('ordinary compaction is unchanged: state equal to the peer, a new write still works', async () => {
    const { a, b, created } = await compactedPair();
    await b.compact();
    expect(await b.hashes()).toEqual(await a.hashes());
    expect((await a.collection(notes).get(created.recordId))?.value).toEqual({ title: 'v3' });
    const next = await a
      .collection(notes)
      .update(created.recordId, { title: 'v4' }, { mutationId: 'mid-u3' });
    expect(next.replayed).toBe(false);
    expect((await a.collection(notes).get(created.recordId))?.value).toEqual({ title: 'v4' });
  });
});
