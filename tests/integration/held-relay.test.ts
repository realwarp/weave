/**
 * [ADV] Held newer-schema ops through a relay over HTTP (T5.5, R8.7). A holding v1 device pulls
 * every op from the relay (the `hold` flag), syncs `complete`, reports that an update is needed,
 * and after the upgrade has the same hashes as the v2 device. A non-holding v1 device still gets
 * the readable prefix only (R4.10).
 */
import { describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f, type Replica } from '@weave/core';
import type { CollectionDefinition } from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import { createRelayServer, listen } from '../../packages/relay/src/server/index.js';

const v1 = defineCollection({ name: 'items', version: 1, fields: { name: f.string() } });
const v2 = defineCollection({
  name: 'items',
  version: 2,
  fields: { name: f.string(), size: f.number() },
  migrations: { 1: ({ fields }) => ({ ...fields }) },
});

let n = 0;
const device = (
  definition: CollectionDefinition,
  hold: boolean,
  backing: MemoryBacking = createMemoryBacking(),
): Promise<Replica> =>
  createReplica({
    storage: memoryStorage({ backing }),
    collections: [definition],
    random: seededRandom(`heldrelay-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(hold ? { holdNewerSchema: true } : {}),
  });
let m = 0;
const mid = () => `hr-${m++}`;

describe('held ops through a relay over HTTP', () => {
  it('a holding device completes, reports the update, and converges after it', async () => {
    const core = new RelayCore({ storage: memoryStorage() });
    await core.open();
    const running = await listen(createRelayServer({ core }), 0);
    const t = () => httpTransport({ baseUrl: running.url });
    try {
      const writer = await device(v2, false);
      const { recordId } = await writer
        .collection(v2)
        .create({ name: 'box', size: 3 }, { mutationId: mid() });
      expect((await writer.sync(t())).status).toBe('complete');

      const plain = await device(v1, false);
      const blocked = await plain.sync(t());
      expect(blocked.status === 'partial' && blocked.code).toBe('PEER_SCHEMA_OLDER');

      const backing = createMemoryBacking();
      const holder = await device(v1, true, backing);
      expect((await holder.sync(t())).status).toBe('complete');
      expect((await holder.status()).held).toEqual({ ops: 1, needs: { items: 2 } });
      expect(await holder.collection(v1).get(recordId)).toBeUndefined();
      expect((await holder.hashes()).ops).toBe((await writer.hashes()).ops);
      await holder.close();

      const upgraded = await device(v2, true, backing);
      expect((await upgraded.status()).held).toBeUndefined();
      expect((await upgraded.collection(v2).get(recordId))?.value).toEqual({
        name: 'box',
        size: 3,
      });
      expect((await upgraded.sync(t())).status).toBe('complete');
      expect(await upgraded.hashes()).toEqual(await writer.hashes());
    } finally {
      await running.close();
    }
  });
});
