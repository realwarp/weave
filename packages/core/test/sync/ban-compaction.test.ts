/**
 * [ADV] A banned endpoint cannot influence compaction (PR #2 review, F2; R10.5 with R3.6).
 * The sync client must check the ban before it stores the horizon and removed list a pull
 * response carries, because that data is untrusted and later drives `compact()`.
 */
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { BanOptions, Replica } from '../../src/contracts/replica.js';
import type { StorageAdapter } from '../../src/contracts/storage.js';
import type { CompactionInfo, SyncEndpoint } from '../../src/contracts/sync.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });
const BAN: BanOptions = { enabled: true, threshold: 3, windowMs: 1_000, banMs: 10_000 };

let seed = 0;
async function open(): Promise<{ r: Replica; storage: StorageAdapter }> {
  const storage = memoryStorage();
  const r = await createReplica({
    storage,
    collections: [notes],
    random: seededRandom(`ban-compaction-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ban: BAN,
  });
  return { r, storage };
}

const tamper = (line: string) => line.replace('"title":"t', '"title":"X');
const storedCompaction = (storage: StorageAdapter) =>
  storage.transaction('ro', (tx) => tx.get('meta/compaction'));

describe('a banned endpoint cannot influence compaction (F2)', () => {
  it('compaction data from a banned endpoint is not stored', async () => {
    const { r: client, storage } = await open();
    const { r: source } = await open();
    for (let i = 0; i < 2; i++)
      await source.collection(notes).create({ title: `t${i}` }, { mutationId: `bc-${i}` });

    const mode: { tamper: boolean; compaction: CompactionInfo | undefined } = {
      tamper: true,
      compaction: undefined,
    };
    const real = source.endpoint();
    const endpoint: SyncEndpoint = {
      ...real,
      pull: async (req) => {
        const res = await real.pull(req);
        return {
          ...res,
          ...(mode.tamper ? { ops: res.ops.map(tamper) } : {}),
          ...(mode.compaction === undefined ? {} : { compaction: mode.compaction }),
        };
      },
    };

    for (let i = 0; i < 3; i++) expect((await client.sync(endpoint)).status).toBe('failed');
    expect((await client.status()).bans).toEqual([{ peer: source.id, remainingMs: 10_000 }]);
    const before = await storedCompaction(storage);

    // Now banned: the endpoint claims a horizon and a removed member.
    mode.tamper = false;
    mode.compaction = {
      horizon: { [source.id]: 2 },
      compactedThrough: {},
      removed: { [client.id]: 0 },
    };
    const res = await client.sync(endpoint);
    expect(res.status === 'failed' && res.code).toBe('PEER_BANNED');
    expect(await storedCompaction(storage)).toEqual(before);
  });
});
