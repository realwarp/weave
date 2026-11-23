/**
 * The IndexedDB adapter passes the storage conformance suite in Chromium (task T2.8, R9.3), plus
 * the browser-specific checks: a second open of one database is refused through the Web Lock, and
 * a full replica runs and survives a reopen on IndexedDB.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f } from '@weave/core';
import { indexedDbStorage } from '@weave/storage/indexeddb';
import { memoryStorage } from '@weave/storage/memory';
import { runStorageConformance } from '../../packages/testing/src/storage/conformance.js';

let n = 0;
const freshName = () => `weave-conformance-${Date.now()}-${n++}`;

runStorageConformance('indexeddb (Chromium)', async () => {
  const name = freshName();
  return {
    adapter: indexedDbStorage({ name }),
    reopen: async () => indexedDbStorage({ name }),
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    },
  };
});

const notes = defineCollection({
  name: 'notes',
  version: 1,
  fields: { title: f.string({ required: true }), tags: f.set(f.string()) },
});

describe('IndexedDB in the engine', () => {
  it('refuses a second open of the same database with STORAGE_LOCKED', async () => {
    const name = freshName();
    const first = indexedDbStorage({ name });
    await first.open();
    await expect(indexedDbStorage({ name }).open()).rejects.toMatchObject({
      code: 'STORAGE_LOCKED',
    });
    await first.close();
    const again = indexedDbStorage({ name });
    await again.open();
    await again.close();
  });

  it('a replica writes, reopens and syncs with equal hashes', async () => {
    const name = freshName();
    let a = await createReplica({ storage: indexedDbStorage({ name }), collections: [notes] });
    const { recordId } = await a
      .collection(notes)
      .create({ title: 'browser', tags: ['x'] }, { mutationId: 'm1' });
    const id = a.id;
    const before = await a.hashes();
    await a.close();
    a = await createReplica({ storage: indexedDbStorage({ name }), collections: [notes] });
    expect(a.id).toBe(id);
    expect(await a.hashes()).toEqual(before);
    expect(
      (await a.collection(notes).create({ title: 'browser', tags: ['x'] }, { mutationId: 'm1' }))
        .replayed,
    ).toBe(true);
    const b = await createReplica({ storage: memoryStorage(), collections: [notes] });
    expect((await b.sync(a.endpoint())).status).toBe('complete');
    expect((await b.collection(notes).get(recordId))?.value.title).toBe('browser');
    expect(await b.hashes()).toEqual(await a.hashes());
    await a.close();
    await b.close();
  });
});
