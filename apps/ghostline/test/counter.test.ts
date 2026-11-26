/**
 * GHOSTLINE "me too" counter (task T5.9, R13.7): requests carry a counter field using the counter
 * resolver; concurrent taps from several devices sum and converge in any sync order; a retried
 * tap never counts twice; version 1 data upgrades to version 2 unchanged; a 0.1.0 app is told it
 * needs an update instead of rejecting the new field.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f } from '@weave/core';
import { createMemoryBacking, memoryStorage } from '@weave/storage/memory';
import { createRequest, listRequests, meToo, meTooCount, type Session } from '../src/logic.js';
import { announcements, collections, requests } from '../src/model.js';
import { memoryPending, runAction } from '../src/pending.js';

async function session(user: string, storage = memoryStorage()): Promise<Session> {
  const replica = await createReplica({ storage, collections });
  return { replica, pending: memoryPending(), user };
}
async function exchange(a: Session, b: Session): Promise<void> {
  expect((await a.replica.sync(b.replica.endpoint())).status).toBe('complete');
  expect((await b.replica.sync(a.replica.endpoint())).status).toBe('complete');
}
const count = async (s: Session, id: string) =>
  meTooCount((await listRequests(s)).find((r) => r.id === id)!);

describe('the "me too" counter (R13.7)', () => {
  it('uses the counter resolver on a version 2 field', () => {
    expect(requests.version).toBe(2);
    expect(requests.fields.meToo.kind).toBe('counter');
    expect(requests.fields.meToo.resolver).toBe('counter');
  });

  it('starts at 0 and counts each tap', async () => {
    const ana = await session('ana');
    const { recordId } = await createRequest(ana, 'r1', 'Need a ladder', 'For the roof');
    expect(await count(ana, recordId)).toBe(0);
    await meToo(ana, recordId);
    await meToo(ana, recordId);
    expect(await count(ana, recordId)).toBe(2);
  });

  it('concurrent taps from three devices all count and converge, whatever the sync order', async () => {
    for (const order of [
      [0, 1, 2, 0, 1],
      [2, 1, 0, 2, 1],
      [1, 2, 0, 1, 2],
    ]) {
      const devices = [await session('ana'), await session('ben'), await session('cho')];
      const [ana, ben, cho] = devices as [Session, Session, Session];
      const { recordId } = await createRequest(ana, 'r1', 'Firewood', 'Out of wood');
      await exchange(ana, ben);
      await exchange(ana, cho);
      // All offline: ana taps once, ben three times, cho twice.
      await meToo(ana, recordId);
      for (let i = 0; i < 3; i++) await meToo(ben, recordId);
      for (let i = 0; i < 2; i++) await meToo(cho, recordId);
      for (let i = 0; i < order.length - 1; i++)
        await exchange(devices[order[i]!]!, devices[order[i + 1]!]!);
      for (const d of devices) expect(await count(d, recordId)).toBe(6);
      const hashes = await Promise.all(devices.map((d) => d.replica.hashes()));
      expect(new Set(hashes.map((h) => JSON.stringify(h))).size).toBe(1);
    }
  });

  it('a tap retried after a crash, with its stored mutationId, counts once', async () => {
    const ana = await session('ana');
    const { recordId } = await createRequest(ana, 'r1', 'Water', 'Bottles');
    // The write lands, then the app crashes before it records the result.
    await runAction(ana.replica, ana.pending, `metoo:${recordId}`, async (mutationId) => {
      await ana.replica.collection(requests).update(recordId, { meToo: 1 }, { mutationId });
      return Promise.reject(new Error('simulated crash'));
    }).catch(() => undefined);
    const retry = await meToo(ana, recordId);
    expect(retry.replayed).toBe(true);
    expect(await count(ana, recordId)).toBe(1);
  });

  it('version 1 requests upgrade unchanged and then take taps', async () => {
    const requestsV1 = defineCollection({
      name: 'requests',
      version: 1,
      fields: {
        title: f.string({ required: true, resolver: 'last-writer-wins' }),
        details: f.string({ resolver: 'last-writer-wins' }),
        tags: f.set(f.string()),
        claimedBy: f.string({ resolver: 'last-writer-wins' }),
        state: f.rank(['open', 'fulfilled'], { required: true }),
      },
    });
    const backing = createMemoryBacking();
    const old = await createReplica({
      storage: memoryStorage({ backing }),
      collections: [announcements, requestsV1],
    });
    const { recordId } = await old
      .collection(requestsV1)
      .create(
        { title: 'Old', details: 'From 0.1.0', tags: ['x'], state: 'open' },
        { mutationId: 'v1-a' },
      );
    await old.close();
    const upgraded = await session('ana', memoryStorage({ backing }));
    const view = (await listRequests(upgraded)).find((r) => r.id === recordId)!;
    expect(view.value).toEqual({ title: 'Old', details: 'From 0.1.0', tags: ['x'], state: 'open' });
    expect(meTooCount(view)).toBe(0);
    await meToo(upgraded, recordId);
    expect(await count(upgraded, recordId)).toBe(1);
  });

  it('a 0.1.0 app syncing with a 0.2.0 one is told to update, and keeps working', async () => {
    const requestsV1 = defineCollection({
      name: 'requests',
      version: 1,
      fields: {
        title: f.string({ required: true, resolver: 'last-writer-wins' }),
        details: f.string({ resolver: 'last-writer-wins' }),
        tags: f.set(f.string()),
        claimedBy: f.string({ resolver: 'last-writer-wins' }),
        state: f.rank(['open', 'fulfilled'], { required: true }),
      },
    });
    const ana = await session('ana');
    const { recordId } = await createRequest(ana, 'r1', 'Ride', 'To town');
    await meToo(ana, recordId);
    const old = await createReplica({
      storage: memoryStorage(),
      collections: [announcements, requestsV1],
    });
    const result = await old.sync(ana.replica.endpoint());
    expect(result.status === 'partial' && result.code).toBe('PEER_SCHEMA_OLDER');
    expect(result.status === 'partial' ? result.blocked.map((b) => b.requiredVersion) : []).toEqual(
      [2],
    );
  });
});
