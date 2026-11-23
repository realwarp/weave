/**
 * Notification crash windows (task T2.5, R15.13, R5.5, D8). Conflict notifications are marked in
 * `notified/` and then emitted, so delivery is at most once; anything not marked is repaired from
 * the conflict history at startup. These tests crash at each window, also repeatedly.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { crashingStorage } from '../../../testing/src/storage/index.js';
import { WeaveError } from '../../src/contracts/errors.js';
import type { WeaveEvent } from '../../src/contracts/events.js';
import type { StorageAdapter, StorageTx } from '../../src/contracts/storage.js';
import { buildOp } from '../../src/ops/op.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { makeReplica } from './helpers.js';

const items = defineCollection({
  name: 'items',
  version: 1,
  fields: { v: f.string(), w: f.string() },
});
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccc';

async function op(
  r: string,
  vector: Record<string, number>,
  lamport: number,
  recordId: string,
  fields: Record<string, string>,
): Promise<string> {
  return (
    await buildOp({
      replicaId: r,
      vector,
      maxLamport: lamport - 1,
      collection: 'items',
      recordId,
      kind: 'set',
      schemaVersion: 1,
      fields,
    })
  ).line;
}

/**
 * One batch with three conflicts: r1.v is superseded by C, r1.w stays open, and r2.v stays open.
 */
async function threeConflicts(): Promise<string[]> {
  return [
    await op(A, {}, 1, 'r1', { v: 'a', w: 'a' }),
    await op(A, { [A]: 1 }, 2, 'r2', { v: 'a' }),
    await op(B, {}, 1, 'r1', { v: 'b', w: 'b' }),
    await op(B, { [B]: 1 }, 2, 'r2', { v: 'b' }),
    await op(C, { [A]: 2, [B]: 2 }, 3, 'r1', { v: 'c' }),
  ];
}

const conflictEvents = (events: WeaveEvent[]) =>
  events.filter((e) => e.type === 'conflict.new') as Array<
    WeaveEvent & { conflictId: string; status: string }
  >;

/** Storage whose transactions that write `notified/` keys crash before commit, `times` times. */
function crashOnMarking(
  inner: StorageAdapter,
  times: number,
): StorageAdapter & { crashes: number } {
  const state = { crashes: 0 };
  return {
    get crashes() {
      return state.crashes;
    },
    open: () => inner.open(),
    close: () => inner.close(),
    transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T> {
      return inner.transaction(mode, async (tx) => {
        let marks = false;
        const proxy: StorageTx = {
          get: (k) => tx.get(k),
          scan: (p, o) => tx.scan(p, o),
          delete: (k) => tx.delete(k),
          put: (k, v) => {
            if (k.startsWith('notified/')) marks = true;
            tx.put(k, v);
          },
        };
        const result = await fn(proxy);
        if (marks && state.crashes < times) {
          state.crashes++;
          throw new WeaveError('STORAGE_ERROR', 'Simulated crash before marking commits');
        }
        return result;
      });
    },
  };
}

/** Simulates the process dying: the next open of the backing must succeed. */
function die(backing: MemoryBacking): void {
  backing.inUse = false;
}

describe('notification crash windows (R15.13)', () => {
  it('several conflicts in one batch, crash before marking: each is repaired once, in ID order', async () => {
    const backing = createMemoryBacking();
    const t = await makeReplica({
      storage: crashOnMarking(memoryStorage({ backing }), 1),
      collections: [items],
    });
    await expect(
      t.replica.endpoint().push({ replicaId: C, support: {}, ops: await threeConflicts() }),
    ).rejects.toBeTruthy();
    expect(conflictEvents(t.events)).toEqual([]);
    die(backing);

    const restarted = await makeReplica({ backing, collections: [items] });
    const events = conflictEvents(restarted.events);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.conflictId)).toEqual(events.map((e) => e.conflictId).sort());
    expect(events.map((e) => e.status).sort()).toEqual(['open', 'open', 'superseded']);
    const history = await restarted.replica.conflicts.history();
    expect(history.map((c) => c.conflictId).sort()).toEqual(events.map((e) => e.conflictId));
    expect(await restarted.replica.conflicts.current()).toHaveLength(2);
    await restarted.replica.close();

    const again = await makeReplica({ backing, collections: [items] });
    expect(conflictEvents(again.events)).toEqual([]);
  });

  it('restart repeated: the repair itself crashes before marking several times, then emits once', async () => {
    const backing = createMemoryBacking();
    const first = await makeReplica({
      storage: crashOnMarking(memoryStorage({ backing }), 1),
      collections: [items],
    });
    await expect(
      first.replica.endpoint().push({ replicaId: C, support: {}, ops: await threeConflicts() }),
    ).rejects.toBeTruthy();
    die(backing);

    const seen: WeaveEvent[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      // Every startup repair crashes before its marking commits: nothing is emitted.
      await expect(
        makeReplica({
          storage: crashOnMarking(memoryStorage({ backing }), 1),
          collections: [items],
        }).then((r) => seen.push(...r.events)),
      ).rejects.toBeTruthy();
      die(backing);
    }
    expect(conflictEvents(seen)).toEqual([]);

    const ok = await makeReplica({ backing, collections: [items] });
    expect(conflictEvents(ok.events)).toHaveLength(3);
    await ok.replica.close();
    for (let i = 0; i < 3; i++) {
      const later = await makeReplica({ backing, collections: [items] });
      expect(conflictEvents(later.events)).toEqual([]);
      await later.replica.close();
    }
  });

  it('crash after marking, before emitting, repeated across restarts: never emitted, still in history', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const t = await makeReplica({ storage: crashing, collections: [items] });
    // Transaction 0 commits the batch, transaction 1 is the marking: crash right after it commits.
    crashing.arm({ failTransaction: (i) => (i === 1 ? 'after-commit' : undefined) });
    await expect(
      t.replica.endpoint().push({ replicaId: C, support: {}, ops: await threeConflicts() }),
    ).rejects.toBeTruthy();
    die(backing);
    for (let i = 0; i < 3; i++) {
      const r = await makeReplica({ backing, collections: [items] });
      expect(conflictEvents(r.events)).toEqual([]);
      expect(await r.replica.conflicts.history()).toHaveLength(3);
      await r.replica.close();
    }
  });

  it('a crash at every write of the apply transaction leaves all-or-nothing and at most one notice', async () => {
    const lines = await threeConflicts();
    // Count the writes of one clean apply.
    const probeBacking = createMemoryBacking();
    const probe = crashingStorage(memoryStorage({ backing: probeBacking }));
    const clean = await makeReplica({ storage: probe, collections: [items] });
    probe.arm({});
    await clean.replica.endpoint().push({ replicaId: C, support: {}, ops: lines });
    const writes = probe.writes;
    const reference = await clean.replica.hashes();
    expect(writes).toBeGreaterThan(5);

    for (let k = 0; k < writes; k++) {
      const backing = createMemoryBacking();
      const crashing = crashingStorage(memoryStorage({ backing }));
      const t = await makeReplica({ storage: crashing, collections: [items] });
      const empty = await t.replica.hashes();
      crashing.arm({ failAfterWrites: k });
      await t.replica
        .endpoint()
        .push({ replicaId: C, support: {}, ops: lines })
        .catch(() => undefined);
      const emitted = conflictEvents(t.events).length;
      die(backing);
      const r = await makeReplica({ backing, collections: [items] });
      const hashes = await r.replica.hashes();
      expect([JSON.stringify(empty), JSON.stringify(reference)], `write ${k}`).toContain(
        JSON.stringify(hashes),
      );
      // Redeliver, then restart once more: in total each conflict is announced at most once.
      await r.replica.endpoint().push({ replicaId: C, support: {}, ops: lines });
      const total = emitted + conflictEvents(r.events).length;
      await r.replica.close();
      const last = await makeReplica({ backing, collections: [items] });
      expect(total + conflictEvents(last.events).length, `write ${k}`).toBeLessThanOrEqual(3);
      expect(await last.replica.hashes()).toEqual(reference);
      await last.replica.close();
    }
  });
});
