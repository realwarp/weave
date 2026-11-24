/**
 * Regression (PR #1 review): claim notices are attributed only to the claims in the conflict
 * frontier. Ana's earlier claim was causally superseded before Ben and Cho claimed concurrently,
 * so Ana is not told she lost that conflict.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, type Replica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import {
  claimRequest,
  createRequest,
  deleteAnnouncement,
  draftAnnouncement,
  editAnnouncement,
  notices,
  type Session,
} from '../src/logic.js';
import { collections } from '../src/model.js';
import { memoryPending } from '../src/pending.js';

async function session(user: string): Promise<Session> {
  const replica = await createReplica({ storage: memoryStorage(), collections });
  return { replica, pending: memoryPending(), user };
}

async function meshSync(...all: Session[]): Promise<void> {
  for (let round = 0; round < 2; round++)
    for (const a of all)
      for (const b of all)
        if (a !== b)
          expect((await a.replica.sync((b.replica as Replica).endpoint())).status).toBe('complete');
}

describe('notices follow the conflict frontier', () => {
  it('an earlier, causally superseded claim is not part of a later conflict', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const cho = await session('cho');
    const { recordId } = await createRequest(ana, 'r1', 'Generator', 'for the shelter');
    await meshSync(ana, ben, cho);

    await claimRequest(ana, recordId); // seen by everyone before the next claims
    await meshSync(ana, ben, cho);

    await claimRequest(ben, recordId); // concurrent with Cho's claim
    await claimRequest(cho, recordId);
    await meshSync(ana, ben, cho);

    const anaNotices = (await notices(ana)).filter((n) => n.recordId === recordId);
    expect(anaNotices.map((n) => n.kind)).toEqual(['claim-conflict']);
    const kinds = [...(await notices(ben)), ...(await notices(cho))].map((n) => n.kind).sort();
    expect(kinds).toEqual(['claim-conflict', 'claim-lost']);
  });

  it('an edit made before a delete, and seen by its author, is not "not applied"', async () => {
    const ana = await session('ana');
    const ben = await session('ben');
    const cho = await session('cho');
    const { recordId } = await draftAnnouncement(ana, 'a1', 'Notice', 'v1');
    await meshSync(ana, ben, cho);
    await editAnnouncement(ben, recordId, { body: 'v2' }); // seen by everyone first
    await meshSync(ana, ben, cho);
    await deleteAnnouncement(ana, recordId); // concurrent with Cho's edit only
    await editAnnouncement(cho, recordId, { body: 'v3' });
    await meshSync(ana, ben, cho);

    expect((await notices(ben)).map((n) => n.kind)).toEqual(['delete-conflict']);
    expect((await notices(cho)).map((n) => n.kind)).toEqual(['edit-not-applied']);
  });
});
