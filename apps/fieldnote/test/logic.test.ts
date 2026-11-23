/**
 * FIELDNOTE logic (task T3.F1, R14.1 to R14.6): concurrent field edits merge, the more advanced
 * status wins, the higher severity wins, the v1 -> v2 migration, the conflict history view data,
 * and the operation history of an inspection.
 */
import { describe, expect, it } from 'vitest';
import { createReplica } from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import {
  addObservation,
  assign,
  conflictHistory,
  createInspection,
  editInspection,
  editObservation,
  inspectionHistory,
  listInspections,
  observationsOf,
  setStatus,
  type Session,
} from '../src/logic.js';
import { collectionsV1, collectionsV2, splitLocation } from '../src/model.js';
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

async function exchange(a: Session, b: Session): Promise<void> {
  expect((await a.replica.sync(b.replica.endpoint())).status).toBe('complete');
  expect((await b.replica.sync(a.replica.endpoint())).status).toBe('complete');
}

describe('FIELDNOTE logic', () => {
  it('concurrent edits of different fields merge; both are kept', async () => {
    const { s: a } = await worker('ana', 2);
    const { s: b } = await worker('ben', 2);
    const { recordId } = await createInspection(a, 'i1', {
      title: 'Bridge 4',
      site: 'North',
      zone: 'A',
    });
    await exchange(a, b);
    await editInspection(a, recordId, { title: 'Bridge 4 (east span)' });
    await editInspection(b, recordId, { zone: 'A3' });
    await assign(a, recordId, ['ana']);
    await assign(b, recordId, ['ben']);
    await exchange(a, b);
    const [row] = await listInspections(b);
    expect(row).toMatchObject({
      title: 'Bridge 4 (east span)',
      where: 'North / A3',
      assignees: ['ana', 'ben'],
    });
    expect(await a.replica.hashes()).toEqual(await b.replica.hashes());
  });

  it('a status conflict resolves to the more advanced status', async () => {
    const { s: a } = await worker('ana', 2);
    const { s: b } = await worker('ben', 2);
    const { recordId } = await createInspection(a, 'i1', { title: 'Pump house', site: 'West' });
    await exchange(a, b);
    await setStatus(a, recordId, 'closed');
    await setStatus(b, recordId, 'in_review');
    await exchange(a, b);
    expect((await listInspections(a))[0]?.status).toBe('closed');
    expect((await listInspections(b))[0]?.status).toBe('closed');
  });

  it('a severity conflict resolves to the higher severity; severity is checked', async () => {
    const { s: a } = await worker('ana', 2);
    const { s: b } = await worker('ben', 2);
    const { recordId: insp } = await createInspection(a, 'i1', { title: 'Dam' });
    const { recordId } = await addObservation(a, 'o1', insp, {
      note: 'Hairline crack',
      severity: 2,
      reading: 0.4,
    });
    await exchange(a, b);
    await editObservation(a, recordId, { severity: 3 });
    await editObservation(b, recordId, { severity: 5, reading: 0.9 });
    await exchange(a, b);
    const [o] = await observationsOf(a, insp);
    expect(o).toMatchObject({ severity: 5, reading: 0.9, note: 'Hairline crack' });
    expect(() => addObservation(a, 'bad', insp, { note: 'x', severity: 6 })).toThrow('severity');
    expect(() => addObservation(a, 'bad2', insp, { note: 'x', severity: 2.5 })).toThrow('severity');
  });

  it('migration: v1 location splits into site and zone on read; stored ops are unchanged', async () => {
    expect(splitLocation('North / A3')).toEqual({ site: 'North', zone: 'A3' });
    expect(splitLocation('North / A3 / x')).toEqual({ site: 'North', zone: 'A3 / x' });
    expect(splitLocation('Depot')).toEqual({ site: 'Depot', zone: '' });

    const { s: v1a, backing: ba } = await worker('ana', 1);
    const { s: v1b, backing: bb } = await worker('ben', 1);
    const { recordId } = await createInspection(v1a, 'i1', {
      title: 'Tunnel',
      location: 'North / A3',
    });
    await createInspection(v1b, 'i2', { title: 'Depot check', location: 'Depot' });
    await exchange(v1a, v1b);
    expect((await listInspections(v1a)).map((r) => r.where)).toEqual(['Depot', 'North / A3']);
    expect(() => editInspection(v1a, recordId, { site: 'x' })).toThrow('version 2');

    // Both workers upgrade: equal state, derived through the migration.
    await v1a.replica.close();
    await v1b.replica.close();
    const { s: a } = await worker('ana', 2, ba);
    const { s: b } = await worker('ben', 2, bb);
    expect(await a.replica.hashes()).toEqual(await b.replica.hashes());
    expect((await listInspections(a)).map((r) => [r.title, r.where])).toEqual([
      ['Depot check', 'Depot'],
      ['Tunnel', 'North / A3'],
    ]);
    await editInspection(a, recordId, { zone: 'B1' });
    await exchange(a, b);
    expect((await listInspections(b)).find((r) => r.id === recordId)?.where).toBe('North / B1');
    const history = await inspectionHistory(b, recordId);
    expect(history.map((h) => h.schemaVersion)).toEqual([1, 2]);
    expect(history[0]?.fields).toMatchObject({ location: 'North / A3' });
    expect(() => editInspection(a, recordId, { location: 'x' })).toThrow('version 2');
  });

  it('the conflict history view lists the competing values and the result', async () => {
    const { s: a } = await worker('ana', 2);
    const { s: b } = await worker('ben', 2);
    const { recordId } = await createInspection(a, 'i1', { title: 'Weir', site: 'South' });
    await exchange(a, b);
    await setStatus(a, recordId, 'in_review');
    await setStatus(b, recordId, 'closed');
    await editInspection(a, recordId, { site: 'South bank' });
    await editInspection(b, recordId, { site: 'South weir' });
    await exchange(a, b);
    const rows = await conflictHistory(a);
    expect(rows).toEqual(await conflictHistory(b));
    const status = rows.find((r) => r.field === 'status')!;
    expect(status).toMatchObject({ recordId, resolved: 'closed', status: 'open' });
    expect([...status.values].sort()).toEqual(['closed', 'in_review']);
    const site = rows.find((r) => r.field === 'site')!;
    expect([...site.values].sort()).toEqual(['South bank', 'South weir']);
    expect(site.values).toContain(site.resolved);
    // A later edit that follows both closes the site conflict; it stays in the history.
    await editInspection(a, recordId, { site: 'South' });
    expect((await conflictHistory(a)).find((r) => r.conflictId === site.conflictId)?.status).toBe(
      'superseded',
    );
    expect((await listInspections(a))[0]?.openConflicts).toBe(1);
  });

  it('operation history of an inspection, oldest first, with concurrent edits marked', async () => {
    const { s: a } = await worker('ana', 2);
    const { s: b } = await worker('ben', 2);
    const { recordId } = await createInspection(a, 'i1', { title: 'Mast', site: 'Hill' });
    await exchange(a, b);
    await editInspection(a, recordId, { zone: '1' });
    await editInspection(b, recordId, { zone: '2' });
    await exchange(a, b);
    await setStatus(b, recordId, 'closed');
    const h = await inspectionHistory(b, recordId);
    expect(h).toHaveLength(4);
    expect(h[0]).toMatchObject({ kind: 'set', by: a.replica.id, concurrentWith: 0 });
    expect(h.slice(1, 3).map((e) => e.concurrentWith)).toEqual([1, 1]);
    expect(h[3]).toMatchObject({
      by: b.replica.id,
      fields: { status: 'closed' },
      concurrentWith: 0,
    });
  });

  it('a retried action reuses its mutationId and is replayed', async () => {
    const { s: a } = await worker('ana', 2);
    const { recordId } = await createInspection(a, 'i1', { title: 'Gate' });
    const first = await createInspection(a, 'i1', { title: 'Gate' });
    expect(first.recordId).not.toBe(recordId); // finished intents are forgotten: a new intent
    a.pending.set(`status:${recordId}:closed`, 'fixed-mutation-id-1');
    const r1 = await setStatus(a, recordId, 'closed');
    a.pending.set(`status:${recordId}:closed`, 'fixed-mutation-id-1');
    const r2 = await setStatus(a, recordId, 'closed');
    expect(r1.replayed).toBe(false);
    expect(r2).toMatchObject({ replayed: true, opId: r1.opId });
  });
});
