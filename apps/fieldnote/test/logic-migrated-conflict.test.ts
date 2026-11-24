/**
 * Regression (PR #1 review): a v1 `location` op that conflicts with a v2 `site` op must appear in
 * the conflict history view. The view reads the conflict frontier (migrated values); raw
 * `collection.history()` keeps returning the op as written.
 */
import { describe, expect, it } from 'vitest';
import { createReplica } from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import {
  conflictHistory,
  createInspection,
  editInspection,
  inspectionHistory,
  type Session,
} from '../src/logic.js';
import { collectionsV1, collectionsV2 } from '../src/model.js';
import { memoryPending } from '../src/pending.js';

async function worker(
  user: string,
  version: 1 | 2,
  backing: MemoryBacking = createMemoryBacking(),
) {
  const replica = await createReplica({
    storage: memoryStorage({ backing }),
    collections: version === 1 ? collectionsV1 : collectionsV2,
  });
  const s: Session = { replica, pending: memoryPending(), user, version };
  return { s, backing };
}

describe('conflict history across schema versions', () => {
  it('a v1 location edit concurrent with a v2 site edit lists both competing values', async () => {
    const { s: v1, backing } = await worker('ana', 1);
    const { s: v2 } = await worker('ben', 2);
    const { recordId } = await createInspection(v1, 'i1', {
      title: 'Culvert',
      location: 'Depot / B',
    });
    // v2 can read v1 ops.
    expect((await v2.replica.sync(v1.replica.endpoint())).status).toBe('complete');

    // Concurrent, offline: ana (still v1) moves it, ben (v2) renames the site.
    await editInspection(v1, recordId, { location: 'North / A3' });
    await editInspection(v2, recordId, { site: 'South' });

    // ana upgrades, then both exchange.
    await v1.replica.close();
    const { s: a } = await worker('ana', 2, backing);
    expect((await a.replica.sync(v2.replica.endpoint())).status).toBe('complete');
    expect((await v2.replica.sync(a.replica.endpoint())).status).toBe('complete');

    const rows = await conflictHistory(a);
    expect(rows).toEqual(await conflictHistory(v2));
    const site = rows.find((r) => r.field === 'site');
    expect(site).toBeDefined();
    expect([...site!.values].sort()).toEqual(['North', 'South']);
    expect(site!.values).toContain(site!.resolved);

    // Raw history is unchanged: the v1 op still carries `location`, not `site`.
    const raw = await inspectionHistory(a, recordId);
    const v1Edit = raw.find((h) => h.schemaVersion === 1 && h.fields['location'] === 'North / A3');
    expect(v1Edit).toBeDefined();
    expect(v1Edit!.fields).not.toHaveProperty('site');
  });
});
