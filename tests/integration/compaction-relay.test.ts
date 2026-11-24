/**
 * [ADV] Compaction through a relay (T5.1, R3.6 to R3.10, R3.13): replicas learn the horizon the
 * relay publishes, compact, keep equal state, a late newcomer is told to bootstrap from a snapshot,
 * and a removed member's list reaches replicas and its later ops are refused.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, type Replica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { simNotesV1 } from '../../packages/testing/src/simulator/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';

let n = 0;
const replica = (compaction = true): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [simNotesV1],
    random: seededRandom(`crelay-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(compaction ? { compaction: { enabled: true } } : {}),
  });

const notes = (r: Replica) => r.collection(simNotesV1);
let m = 0;
const mid = () => `cr-${m++}`;

async function relay() {
  const core = new RelayCore({ storage: memoryStorage(), compaction: { enabled: true } });
  await core.open();
  return core;
}

describe('compaction through a relay', () => {
  it('replicas use the published horizon, compact, and still converge', async () => {
    const hub = await relay();
    const [a, b] = [await replica(), await replica()];
    const { recordId } = await notes(a).create({ title: '1', n: 1 }, { mutationId: mid() });
    for (let i = 2; i <= 4; i++)
      await notes(a).update(recordId, { title: `${i}`, n: i }, { mutationId: mid() });
    for (let round = 0; round < 2; round++)
      for (const r of [a, b]) expect((await r.sync(hub)).status).toBe('complete');

    const horizon = (await a.status()).compaction?.horizon;
    expect(horizon?.[a.id]).toBe(4);
    const before = await a.hashes();
    expect((await a.compact()).removedOps).toBe(3);
    expect((await b.compact()).removedOps).toBe(3);
    expect(await a.hashes()).toEqual(await b.hashes());
    expect((await a.hashes()).state).toBe(before.state);
    expect((await hub.compact()).removedOps).toBe(4);

    // Normal work continues after compaction.
    await notes(b).update(recordId, { title: 'after' }, { mutationId: mid() });
    for (let round = 0; round < 2; round++)
      for (const r of [a, b]) expect((await r.sync(hub)).status).toBe('complete');
    expect((await notes(a).get(recordId))?.value.title).toBe('after');
    expect(await a.hashes()).toEqual(await b.hashes());
  });

  it('an offline member that never acknowledged holds everything back (R3.7)', async () => {
    const hub = await relay();
    const [a, offline] = [await replica(), await replica()];
    await offline.sync(hub); // registers as a member, holds nothing yet
    const { recordId } = await notes(a).create({ title: '1' }, { mutationId: mid() });
    await notes(a).update(recordId, { title: '2' }, { mutationId: mid() });
    expect((await a.sync(hub)).status).toBe('complete');
    expect((await a.sync(hub)).status).toBe('complete');
    expect((await hub.horizon())[a.id]).toBeUndefined();
    expect((await a.compact()).removedOps).toBe(0);
    expect((await hub.compact()).removedOps).toBe(0);
    // When the member comes back it receives everything.
    expect((await offline.sync(hub)).status).toBe('complete');
    expect(await offline.hashes()).toEqual(await a.hashes());
  });

  it('a newcomer after relay compaction gets NEEDS_SNAPSHOT; a deleted record is never resurrected', async () => {
    const hub = await relay();
    const a = await replica();
    const { recordId } = await notes(a).create({ title: 'gone soon' }, { mutationId: mid() });
    await notes(a).delete(recordId, { mutationId: mid() });
    expect((await a.sync(hub)).status).toBe('complete');
    expect((await a.sync(hub)).status).toBe('complete');
    expect((await hub.compact()).removedOps).toBe(2);
    expect((await a.compact()).removedOps).toBe(1); // the set op; the delete stays as the tombstone
    const late = await replica();
    const res = await late.sync(hub);
    expect(res.status === 'failed' && res.code).toBe('NEEDS_SNAPSHOT');
    expect(await notes(late).query({ includeDeleted: true })).toEqual([]);
    expect(await notes(a).get(recordId)).toBeUndefined();
  });

  it('the relay removed list reaches replicas, which then refuse the member directly too', async () => {
    const hub = await relay();
    const [a, gone] = [await replica(), await replica()];
    await notes(a).create({ title: 'a' }, { mutationId: mid() });
    await notes(gone).create({ title: 'g' }, { mutationId: mid() });
    for (const r of [a, gone, a]) expect((await r.sync(hub)).status).toBe('complete');
    await hub.removePeer(gone.id);
    expect((await a.sync(hub)).status).toBe('complete');
    expect((await a.status()).compaction?.removed[gone.id]).toBe(1);
    // The removed device writes more and tries the relay, then the replica directly.
    await notes(gone).create({ title: 'after removal' }, { mutationId: mid() });
    const viaRelay = await gone.sync(hub);
    expect(viaRelay.status).toBe('failed');
    const direct = await gone.sync(a.endpoint());
    expect(direct.rejectedOrigins).toContainEqual(
      expect.objectContaining({ origin: gone.id, code: 'PEER_REMOVED' }),
    );
    expect((await a.status()).vector[gone.id]).toBe(1);
  });
});
