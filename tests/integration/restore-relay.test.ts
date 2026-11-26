/**
 * [ADV] `restore` and `update-wins` through a relay over HTTP (T5.3, R6.9, D6). The relay stays
 * opaque: it stores and forwards restore ops like any other op, and devices converge to equal
 * hashes. A device whose collection does not enable restore rejects them with NOT_SUPPORTED.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f, type Replica } from '@weave/core';
import type { CollectionDefinition } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import { createRelayServer, listen } from '../../packages/relay/src/server/index.js';

const fields = { title: f.string({ required: true }) };
const tasks = defineCollection({
  name: 'tasks',
  version: 1,
  fields,
  deletes: { policy: 'update-wins', restore: true },
});
const plainTasks = defineCollection({ name: 'tasks', version: 1, fields });

let n = 0;
const device = (definition: CollectionDefinition = tasks): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [definition],
    random: seededRandom(`restorerelay-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
const col = (r: Replica) => r.collection(tasks);
let m = 0;
const mid = () => `rr-${m++}`;

describe('restore through a relay over HTTP', () => {
  it('restore and update-wins converge on every device', async () => {
    const core = new RelayCore({ storage: memoryStorage() });
    await core.open();
    const running = await listen(createRelayServer({ core }), 0);
    const t = () => httpTransport({ baseUrl: running.url });
    const syncAll = async (devices: Replica[]) => {
      for (let i = 0; i < 2; i++)
        for (const d of devices) expect((await d.sync(t())).status).toBe('complete');
    };
    try {
      const [a, b, c] = [await device(), await device(), await device()];
      const { recordId: kept } = await col(a).create({ title: 'kept' }, { mutationId: mid() });
      const { recordId: back } = await col(a).create({ title: 'back' }, { mutationId: mid() });
      await syncAll([a, b, c]);
      // update-wins: a deletes while b edits, concurrently.
      await col(a).delete(kept, { mutationId: mid() });
      await col(b).update(kept, { title: 'edited' }, { mutationId: mid() });
      // restore: c deletes, then (after sync) b restores.
      await col(c).delete(back, { mutationId: mid() });
      await syncAll([a, b, c]);
      for (const d of [a, b, c]) expect(await col(d).get(back)).toBeUndefined();
      await col(b).restore(back, { mutationId: mid() });
      await syncAll([a, b, c]);
      const hashes = await Promise.all([a, b, c].map((d) => d.hashes()));
      expect(new Set(hashes.map((h) => JSON.stringify(h))).size).toBe(1);
      for (const d of [a, b, c]) {
        expect((await col(d).get(kept))?.value).toEqual({ title: 'edited' });
        expect((await col(d).get(back))?.value).toEqual({ title: 'back' });
      }

      // A device whose collection does not enable restore refuses the restore op.
      const old = await device(plainTasks);
      const refused = await old.sync(t());
      expect(refused.status === 'failed' && refused.code).toBe('NOT_SUPPORTED');
    } finally {
      await running.close();
    }
  });
});
