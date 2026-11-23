import {
  createMemoryBacking,
  memoryStorage,
  type MemoryBacking,
} from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { WeaveEvent } from '../../src/contracts/events.js';
import type { Replica } from '../../src/contracts/replica.js';
import type { StorageAdapter } from '../../src/contracts/storage.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';

export const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: {
    title: f.string({ required: true }),
    body: f.string(),
    tags: f.set(f.string()),
    priority: f.number({ resolver: 'max' }),
    status: f.rank(['open', 'in_review', 'closed']),
  },
});

export interface TestReplica {
  replica: Replica;
  backing: MemoryBacking;
  events: WeaveEvent[];
  reopen: (storage?: StorageAdapter) => Promise<TestReplica>;
}

let counter = 0;

export async function makeReplica(
  options: {
    seed?: number | string;
    backing?: MemoryBacking;
    storage?: StorageAdapter;
    collections?: Parameters<typeof createReplica>[0]['collections'];
  } = {},
): Promise<TestReplica> {
  const seed = options.seed ?? `replica-${counter++}`;
  const backing = options.backing ?? createMemoryBacking();
  const events: WeaveEvent[] = [];
  const replica = await createReplica({
    storage: options.storage ?? memoryStorage({ backing }),
    collections: options.collections ?? [notes],
    random: seededRandom(seed),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    logger: (e) => events.push(e),
  });
  return {
    replica,
    backing,
    events,
    reopen: async (storage) => {
      await replica.close();
      return makeReplica({
        seed: `${String(seed)}-reopen-${counter++}`,
        backing,
        ...(storage === undefined ? {} : { storage }),
        ...(options.collections === undefined ? {} : { collections: options.collections }),
      });
    },
  };
}

/** Full bidirectional exchange until both report complete. */
export async function syncPair(a: Replica, b: Replica): Promise<void> {
  const r1 = await a.sync(b.endpoint());
  const r2 = await b.sync(a.endpoint());
  if (r1.status !== 'complete' || r2.status !== 'complete') {
    throw new Error(`sync did not complete: ${r1.status} / ${r2.status}`);
  }
}

export async function sameHashes(...replicas: Replica[]): Promise<boolean> {
  const all = await Promise.all(replicas.map((r) => r.hashes()));
  return all.every((h) => JSON.stringify(h) === JSON.stringify(all[0]));
}
