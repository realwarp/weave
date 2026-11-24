/** Conflict notifications: mark-then-emit, at-most-once, history-based recovery (D8, R15.13). */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '../../../storage/src/memory/index.js';
import { crashingStorage } from '../../../testing/src/storage/index.js';
import type { WeaveEvent } from '../../src/contracts/events.js';
import { buildOp } from '../../src/ops/op.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { makeReplica } from './helpers.js';

const items = defineCollection({ name: 'items', version: 1, fields: { v: f.string() } });
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccc';

/** A and B write the same field concurrently; C's op follows both (one batch, superseded conflict). */
async function supersededBatch(): Promise<string[]> {
  const mk = async (r: string, vector: Record<string, number>, lamport: number, v: string) =>
    (
      await buildOp({
        replicaId: r,
        vector,
        maxLamport: lamport - 1,
        collection: 'items',
        recordId: 'r1',
        kind: 'set',
        schemaVersion: 1,
        fields: { v },
      })
    ).line;
  return [
    await mk(A, {}, 1, 'a'),
    await mk(B, {}, 1, 'b'),
    await mk(C, { [A]: 1, [B]: 1 }, 2, 'c'),
  ];
}

const conflictEvents = (events: WeaveEvent[]) => events.filter((e) => e.type === 'conflict.new');

describe('conflict notifications (D8)', () => {
  it('emits a conflict once, also when it is superseded within the same batch', async () => {
    const t = await makeReplica({ collections: [items] });
    await t.replica.endpoint().push({ replicaId: C, support: {}, ops: await supersededBatch() });
    expect(conflictEvents(t.events)).toEqual([expect.objectContaining({ status: 'superseded' })]);
    expect(await t.replica.conflicts.current()).toEqual([]);
    const log = await t.replica.conflicts.history();
    expect(log.map((c) => c.status)).toEqual(['superseded']);
    // replays and rebuilds never notify again
    await t.replica.endpoint().push({ replicaId: C, support: {}, ops: await supersededBatch() });
    await t.replica.rebuild();
    const again = await t.reopen();
    expect(conflictEvents(t.events)).toHaveLength(1);
    expect(conflictEvents(again.events)).toHaveLength(0);
  });

  it('a crash before marking is repaired at startup from the history (superseded included)', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const t = await makeReplica({ storage: crashing, collections: [items] });
    // transaction 0: the apply commit; transaction 1: the notified/ marking -> crash before commit
    crashing.arm({ failTransaction: (i) => (i === 1 ? 'before-commit' : undefined) });
    await expect(
      t.replica.endpoint().push({ replicaId: C, support: {}, ops: await supersededBatch() }),
    ).rejects.toBeTruthy();
    expect(conflictEvents(t.events)).toHaveLength(0);
    await crashing.inner.close();
    const restarted = await makeReplica({ backing, collections: [items] });
    expect(conflictEvents(restarted.events)).toEqual([
      expect.objectContaining({ status: 'superseded' }),
    ]);
    expect((await restarted.replica.conflicts.history()).map((c) => c.conflictId)).toEqual([
      (conflictEvents(restarted.events)[0] as { conflictId: string }).conflictId,
    ]);
    await restarted.replica.close();
    const second = await makeReplica({ backing, collections: [items] });
    expect(conflictEvents(second.events)).toHaveLength(0);
  });

  it('a crash between marking and emitting loses that notification and never repeats it', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const t = await makeReplica({ storage: crashing, collections: [items] });
    crashing.arm({ failTransaction: (i) => (i === 1 ? 'after-commit' : undefined) });
    await expect(
      t.replica.endpoint().push({ replicaId: C, support: {}, ops: await supersededBatch() }),
    ).rejects.toBeTruthy();
    expect(conflictEvents(t.events)).toHaveLength(0);
    await crashing.inner.close();
    const restarted = await makeReplica({ backing, collections: [items] });
    expect(conflictEvents(restarted.events)).toHaveLength(0);
    // the conflict is still recoverable from the log
    expect(await restarted.replica.conflicts.history()).toHaveLength(1);
  });

  it('an open conflict is reported with status open', async () => {
    const t = await makeReplica({ collections: [items] });
    const lines = (await supersededBatch()).slice(0, 2);
    await t.replica.endpoint().push({ replicaId: B, support: {}, ops: lines });
    expect(conflictEvents(t.events)).toEqual([expect.objectContaining({ status: 'open' })]);
    expect((await t.replica.conflicts.current()).length).toBe(1);
  });
});
