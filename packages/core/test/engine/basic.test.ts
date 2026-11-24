import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '../../../storage/src/memory/index.js';
import { crashingStorage } from '../../../testing/src/storage/index.js';
import { WeaveError } from '../../src/contracts/errors.js';
import { makeReplica, notes, sameHashes, syncPair } from './helpers.js';

describe('replica: local writes and reads (R1, R2, R5.4)', () => {
  it('creates, updates, reads, queries and deletes offline', async () => {
    const { replica } = await makeReplica();
    const col = replica.collection(notes);
    const a = await col.create({ title: 'b', tags: ['x'] }, { mutationId: 'm1' });
    const b = await col.create({ title: 'a', priority: 2 }, { mutationId: 'm2' });
    await col.update(a.recordId, { body: 'hello', tags: ['x', 'y'] }, { mutationId: 'm3' });
    expect((await col.get(a.recordId))?.value).toEqual({
      title: 'b',
      body: 'hello',
      tags: ['x', 'y'],
    });
    expect((await col.query({ orderBy: 'title' })).map((r) => r.value.title)).toEqual(['a', 'b']);
    expect((await col.query({ where: { title: 'a' } })).map((r) => r.id)).toEqual([b.recordId]);
    await col.delete(a.recordId, { mutationId: 'm4' });
    expect(await col.get(a.recordId)).toBeUndefined();
    expect((await col.query()).map((r) => r.id)).toEqual([b.recordId]);
    expect((await col.query({ includeDeleted: true })).length).toBe(2);
    await expect(col.update(a.recordId, { body: 'x' }, { mutationId: 'm5' })).rejects.toMatchObject(
      {
        code: 'RECORD_DELETED',
      },
    );
  });

  it('rejects invalid writes before storing anything', async () => {
    const { replica } = await makeReplica();
    const col = replica.collection(notes);
    const before = await replica.hashes();
    await expect(
      col.create({ body: 'no title' } as never, { mutationId: 'x1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(col.create({ title: 1 } as never, { mutationId: 'x2' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      col.create({ title: 't', status: 'lost' } as never, { mutationId: 'x3' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      col.create({ title: 't', when: new Date() } as never, { mutationId: 'x4' }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_VALUE',
    });
    await expect(col.update('missing', { body: 'x' }, { mutationId: 'x5' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await replica.hashes()).toEqual(before);
  });

  it('requires a valid caller-supplied mutationId at runtime (R5.4)', async () => {
    const { replica } = await makeReplica();
    const col = replica.collection(notes);
    for (const options of [
      undefined,
      {},
      { mutationId: '' },
      { mutationId: 'has space' },
      { mutationId: 'x'.repeat(129) },
    ]) {
      await expect(col.create({ title: 't' }, options as never)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect((await replica.status()).vector).toEqual({});
    expect(replica.newMutationId()).toMatch(/^[a-z2-7]{26}$/);
  });

  it('an identical retry returns the original result; a different payload is MUTATION_ID_REUSED', async () => {
    const { replica } = await makeReplica();
    const col = replica.collection(notes);
    const first = await col.create({ title: 'once' }, { mutationId: 'form-1' });
    const again = await col.create({ title: 'once' }, { mutationId: 'form-1' });
    expect(again).toEqual({ ...first, replayed: true });
    await expect(col.create({ title: 'other' }, { mutationId: 'form-1' })).rejects.toMatchObject({
      code: 'MUTATION_ID_REUSED',
    });
    const up = await col.update(first.recordId, { body: 'b' }, { mutationId: 'up-1' });
    expect(await col.update(first.recordId, { body: 'b' }, { mutationId: 'up-1' })).toEqual({
      ...up,
      replayed: true,
    });
    const del = await col.delete(first.recordId, { mutationId: 'del-1' });
    expect(await col.delete(first.recordId, { mutationId: 'del-1' })).toEqual({
      ...del,
      replayed: true,
    });
    expect((await replica.status()).vector[replica.id]).toBe(3);
  });

  it('concurrent identical calls create one op', async () => {
    const { replica } = await makeReplica();
    const col = replica.collection(notes);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => col.create({ title: 'same' }, { mutationId: 'dup' })),
    );
    expect(new Set(results.map((r) => r.recordId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await replica.status()).vector[replica.id]).toBe(1);
  });

  it('a crash after commit and before the response is recovered by retrying with the same ID (R15.15)', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const { replica } = await makeReplica({ storage: crashing });
    const col = replica.collection(notes);
    await col.create({ title: 'before' }, { mutationId: 'm0' });
    crashing.arm({ failAfterCommit: true });
    await expect(col.create({ title: 'crash' }, { mutationId: 'm1' })).rejects.toBeInstanceOf(
      WeaveError,
    );
    expect(crashing.commits).toBe(1);
    await crashing.inner.close(); // the crashed process is gone
    // "restart": a new replica over the same data
    const restarted = await makeReplica({ backing });
    const before = await restarted.replica.hashes();
    const retry = await restarted.replica
      .collection(notes)
      .create({ title: 'crash' }, { mutationId: 'm1' });
    expect(retry.replayed).toBe(true);
    expect(await restarted.replica.hashes()).toEqual(before);
    expect((await restarted.replica.status()).vector[restarted.replica.id]).toBe(2);
  });

  it('a crash before commit stores nothing', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const { replica } = await makeReplica({ storage: crashing });
    crashing.arm({ failAfterWrites: 2 });
    await expect(
      replica.collection(notes).create({ title: 'lost' }, { mutationId: 'm1' }),
    ).rejects.toBeInstanceOf(WeaveError);
    await crashing.inner.close(); // the crashed process is gone
    const restarted = await makeReplica({ backing });
    expect((await restarted.replica.status()).vector).toEqual({});
    const r = await restarted.replica
      .collection(notes)
      .create({ title: 'lost' }, { mutationId: 'm1' });
    expect(r.replayed).toBe(false);
  });

  it('restores everything after a restart (R1.2)', async () => {
    const t = await makeReplica();
    const col = t.replica.collection(notes);
    const r = await col.create({ title: 'persist', tags: ['a'] }, { mutationId: 'p1' });
    const before = await t.replica.hashes();
    const again = await t.reopen();
    expect(again.replica.id).toBe(t.replica.id);
    expect(await again.replica.hashes()).toEqual(before);
    expect((await again.replica.collection(notes).get(r.recordId))?.value).toEqual({
      title: 'persist',
      tags: ['a'],
    });
  });

  it('notifies subscribers of local and sync changes', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    const seen: string[] = [];
    const off = b.replica.subscribe((c) => seen.push(`${c.source}:${c.kind}`));
    await b.replica.collection(notes).create({ title: 'local' }, { mutationId: 'l1' });
    await a.replica.collection(notes).create({ title: 'remote' }, { mutationId: 'r1' });
    await syncPair(a.replica, b.replica);
    off();
    expect(seen).toEqual(['local:set', 'sync:set']);
  });
});

describe('sync between two replicas (R4, R7)', () => {
  it('the quick-start flow converges', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    const created = await a.replica
      .collection(notes)
      .create({ title: 'Need a ride' }, { mutationId: 'q1' });
    const result = await b.replica.sync(a.replica.endpoint());
    expect(result.status).toBe('complete');
    expect((await b.replica.collection(notes).get(created.recordId))?.value).toEqual({
      title: 'Need a ride',
    });
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });

  it('merges different fields without a conflict, resolves the same field by its resolver', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    const { recordId } = await a.replica
      .collection(notes)
      .create({ title: 't' }, { mutationId: 'c' });
    await syncPair(a.replica, b.replica);
    await a.replica
      .collection(notes)
      .update(
        recordId,
        { body: 'from a', priority: 1, status: 'closed', tags: ['a'] },
        { mutationId: 'ua' },
      );
    await b.replica
      .collection(notes)
      .update(
        recordId,
        { title: 'from b', priority: 5, status: 'in_review', tags: ['b'] },
        { mutationId: 'ub' },
      );
    await syncPair(a.replica, b.replica);
    const va = await a.replica.collection(notes).get(recordId);
    const vb = await b.replica.collection(notes).get(recordId);
    expect(va?.value).toEqual({
      title: 'from b',
      body: 'from a',
      priority: 5,
      status: 'closed',
      tags: ['a', 'b'],
    });
    expect(vb?.value).toEqual(va?.value);
    expect(va?.conflicts.map((c) => c.field).sort()).toEqual(['priority', 'status', 'tags']);
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });

  it('delete wins over a concurrent update and produces a delete conflict (R6.7)', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    const { recordId } = await a.replica
      .collection(notes)
      .create({ title: 't' }, { mutationId: 'c' });
    await syncPair(a.replica, b.replica);
    await a.replica.collection(notes).delete(recordId, { mutationId: 'd' });
    await b.replica.collection(notes).update(recordId, { body: 'edit' }, { mutationId: 'e' });
    await syncPair(a.replica, b.replica);
    expect(await a.replica.collection(notes).get(recordId)).toBeUndefined();
    expect(await b.replica.collection(notes).get(recordId)).toBeUndefined();
    const conflicts = await b.replica.conflicts.current();
    expect(conflicts.map((c) => c.kind)).toEqual(['delete']);
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });
});
