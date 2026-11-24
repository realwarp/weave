/**
 * [ADV] Snapshot bootstrap through a relay (T5.2, R4.8, R3.10): after the relay compacted, a new
 * device and a removed device that rejoins with a fresh replica ID bootstrap from the relay's
 * snapshot and continue normal sync to equal hashes. A deleted record never comes back.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, type Replica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { simNotesV1 } from '../../packages/testing/src/simulator/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import { createRelayServer, listen } from '../../packages/relay/src/server/index.js';

let n = 0;
const device = (): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [simNotesV1],
    random: seededRandom(`snaprelay-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    compaction: { enabled: true },
  });
const notes = (r: Replica) => r.collection(simNotesV1);
let m = 0;
const mid = () => `sr-${m++}`;

describe('bootstrap through a relay over HTTP', () => {
  it('new and rejoining devices bootstrap from the relay snapshot and converge', async () => {
    const core = new RelayCore({ storage: memoryStorage(), compaction: { enabled: true } });
    await core.open();
    const running = await listen(createRelayServer({ core }), 0);
    const t = () => httpTransport({ baseUrl: running.url });
    try {
      const [a, old] = [await device(), await device()];
      const { recordId } = await notes(a).create({ title: '1', n: 1 }, { mutationId: mid() });
      await notes(a).update(recordId, { title: '2', n: 2 }, { mutationId: mid() });
      const { recordId: gone } = await notes(old).create({ title: 'temp' }, { mutationId: mid() });
      await notes(old).delete(gone, { mutationId: mid() });
      for (let i = 0; i < 2; i++)
        for (const r of [a, old]) expect((await r.sync(t())).status).toBe('complete');

      // The old device is retired; the relay compacts what every remaining member holds.
      await core.removePeer(old.id);
      await a.sync(t());
      await a.compact();
      expect((await core.compact()).removedOps).toBeGreaterThan(0);
      await t().putSnapshot!(await a.exportSnapshot());

      // A brand-new device and the old device's replacement (fresh ID) both need the snapshot.
      for (const fresh of [await device(), await device()]) {
        const refused = await fresh.sync(t());
        expect(refused.status === 'failed' && refused.code).toBe('NEEDS_SNAPSHOT');
        await fresh.bootstrap(t());
        expect((await fresh.sync(t())).status).toBe('complete');
        await notes(fresh).update(
          recordId,
          { title: `from ${fresh.id.slice(0, 4)}` },
          { mutationId: mid() },
        );
        expect((await fresh.sync(t())).status).toBe('complete');
        expect((await a.sync(t())).status).toBe('complete');
        expect((await fresh.sync(t())).status).toBe('complete');
        expect((await fresh.hashes()).state).toBe((await a.hashes()).state);
        expect(await notes(fresh).get(gone)).toBeUndefined();
      }
      // The retired ID stays refused.
      await notes(old).create({ title: 'after retirement' }, { mutationId: mid() });
      expect((await old.sync(t())).status).toBe('failed');
    } finally {
      await running.close();
      await core.close();
    }
  });
});
