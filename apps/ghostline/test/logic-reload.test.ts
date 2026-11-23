/**
 * A form submission survives a reload (design 13, R5.4): the intent key and the mutationId live in
 * localStorage until the write is recorded, so re-submitting after a crash is a replay.
 */
import { describe, expect, it } from 'vitest';
import { createReplica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { createRequest, listRequests, type Session } from '../src/logic.js';
import { collections, requests } from '../src/model.js';
import { formIntent, localPending, runAction } from '../src/pending.js';

/** A minimal stand-in for window.localStorage that outlives a "page". */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('form intents across a reload', () => {
  it('re-submitting after a crash replays the create instead of making a second record', async () => {
    const storage = fakeStorage();
    const replica = await createReplica({ storage: memoryStorage(), collections });

    // Page 1: the user submits. The create commits, then the tab dies before the result is recorded.
    const pending1 = localPending('ana', storage);
    const intent = formIntent('ana', storage, 'request').get();
    await expect(
      runAction(replica, pending1, `request:${intent}`, async (mutationId) => {
        await replica
          .collection(requests)
          .create(
            { title: 'Sandbags', details: 'river path', tags: [], state: 'open' },
            { mutationId },
          );
        throw new Error('tab closed');
      }),
    ).rejects.toThrow('tab closed');

    // Page 2: new objects over the same storage. The form names the same intent, so the stored
    // mutationId is reused and the create is replayed, not repeated.
    const page2: Session = { replica, pending: localPending('ana', storage), user: 'ana' };
    const form = formIntent('ana', storage, 'request');
    expect(form.get()).toBe(intent);
    const again = await createRequest(page2, form.get(), 'Sandbags', 'river path');
    form.done();
    expect(again.replayed).toBe(true);
    expect(await listRequests(page2)).toHaveLength(1);
    expect(page2.pending.get(`request:${intent}`)).toBeUndefined();

    // The next submission is a new intent and a new record.
    const next = formIntent('ana', storage, 'request').get();
    expect(next).not.toBe(intent);
    expect((await createRequest(page2, next, 'Blankets', '')).replayed).toBe(false);
    expect(await listRequests(page2)).toHaveLength(2);
  });
});
