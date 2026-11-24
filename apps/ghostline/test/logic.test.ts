/**
 * GHOSTLINE logic (task T3.G1, R13.1 to R13.5): offline create, publish, claim conflict, tag
 * union, delete versus edit, and a retry with the same mutationId returning `replayed`.
 */
import { describe, expect, it } from 'vitest';
import { createReplica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import {
  claimRequest,
  createRequest,
  deleteAnnouncement,
  draftAnnouncement,
  editAnnouncement,
  listAnnouncements,
  listRequests,
  notices,
  publishAnnouncement,
  tagRequest,
  type Session,
} from '../src/logic.js';
import { collections, requests } from '../src/model.js';
import { memoryPending, runAction } from '../src/pending.js';

async function session(
  user: string,
): Promise<Session & { pending: ReturnType<typeof memoryPending> }> {
  const replica = await createReplica({ storage: memoryStorage(), collections });
  return { replica, pending: memoryPending(), user };
}

/** Both directions, so both replicas end with the same op set. */
async function exchange(a: Session, b: Session): Promise<void> {
  expect((await a.replica.sync(b.replica.endpoint())).status).toBe('complete');
  expect((await b.replica.sync(a.replica.endpoint())).status).toBe('complete');
}

describe('GHOSTLINE logic', () => {
  it('creates content offline and shares it on the next sync', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    await draftAnnouncement(ana, 'a1', 'Water outage', 'Tuesday 9-12');
    await createRequest(ben, 'r1', 'Need a ladder', 'For the roof', ['tools']);
    expect(await listAnnouncements(ben)).toHaveLength(0);
    await exchange(ana, ben);
    expect((await listAnnouncements(ben)).map((a) => a.value.title)).toEqual(['Water outage']);
    expect((await listRequests(ana)).map((r) => r.value.title)).toEqual(['Need a ladder']);
    expect(await ana.replica.hashes()).toEqual(await ben.replica.hashes());
  });

  it('publishing is monotonic: a concurrent edit never moves a published item back to draft', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const { recordId } = await draftAnnouncement(ana, 'a1', 'Market day', 'Saturday');
    await exchange(ana, ben);
    await publishAnnouncement(ana, recordId);
    await editAnnouncement(ben, recordId, { body: 'Saturday, 8am' });
    await exchange(ana, ben);
    const [a] = await listAnnouncements(ben);
    expect(a?.value).toMatchObject({ status: 'published', body: 'Saturday, 8am' });
  });

  it('two claims: one claimant wins everywhere, and the loser gets a notice', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const { recordId } = await createRequest(ana, 'r1', 'Groceries for Mrs. Lee', 'Thursday');
    await exchange(ana, ben);
    await claimRequest(ana, recordId);
    await claimRequest(ben, recordId);
    await exchange(ana, ben);
    const winner = (await req(ana, recordId)).claimedBy;
    expect(winner).toBe((await req(ben, recordId)).claimedBy);
    expect(['ana', 'ben']).toContain(winner);
    const loser = winner === 'ana' ? ben : ana;
    const theirs = await notices(loser);
    expect(theirs).toEqual([expect.objectContaining({ kind: 'claim-lost', recordId, open: true })]);
    expect(theirs[0]!.message).toContain(`${winner} has this request`);
    expect((await notices(winner === 'ana' ? ana : ben))[0]?.kind).toBe('claim-conflict');
  });

  it('concurrent tag edits are merged, none is lost', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const { recordId } = await createRequest(ana, 'r1', 'Blankets', '', ['winter']);
    await exchange(ana, ben);
    await tagRequest(ana, recordId, ['urgent']);
    await tagRequest(ben, recordId, ['clothing']);
    await exchange(ana, ben);
    expect((await req(ana, recordId)).tags).toEqual(['clothing', 'urgent', 'winter']);
    expect(await notices(ana)).toEqual([]);
  });

  it('delete versus edit: the delete wins and the editor is told the edit was not applied', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const { recordId } = await draftAnnouncement(ana, 'a1', 'Old notice', 'x');
    await exchange(ana, ben);
    await deleteAnnouncement(ana, recordId);
    await editAnnouncement(ben, recordId, { body: 'updated' });
    await exchange(ana, ben);
    expect(await listAnnouncements(ana)).toEqual([]);
    expect(await listAnnouncements(ben)).toEqual([]);
    const benNotices = await notices(ben);
    expect(benNotices).toEqual([expect.objectContaining({ kind: 'edit-not-applied', recordId })]);
    expect((await notices(ana))[0]?.kind).toBe('delete-conflict');
  });

  it('a retry after a crash reuses the stored mutationId and returns replayed', async () => {
    const ana = await session('ana');
    const { recordId } = await createRequest(ana, 'r1', 'Firewood', '');
    // The write commits, then the device "crashes" before recording the result.
    const crash = runAction(ana.replica, ana.pending, `claim:${recordId}`, async (mutationId) => {
      await ana.replica.collection(requests).update(recordId, { claimedBy: 'ana' }, { mutationId });
      throw new Error('crash before the result was recorded');
    });
    await expect(crash).rejects.toThrow('crash');
    const stored = ana.pending.get(`claim:${recordId}`);
    expect(stored).toBeDefined();
    const before = await ana.replica.hashes();
    const retry = await claimRequest(ana, recordId);
    expect(retry.replayed).toBe(true);
    expect(await ana.replica.hashes()).toEqual(before);
    expect(ana.pending.get(`claim:${recordId}`)).toBeUndefined();
    // A new intent gets a new ID and a new op.
    expect((await tagRequest(ana, recordId, ['wood'])).replayed).toBe(false);
  });
});

async function req(s: Session, id: string) {
  const r = await s.replica.collection(requests).get(id);
  if (r === undefined) throw new Error(`request ${id} is missing`);
  return r.value;
}
