/**
 * applyIncoming (design 7.3): validation atomicity, identity checks across op/ and pend/, copies
 * inside a batch, pending promotion (incl. crash atomicity), and schema-aware delivery (R15.11).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '../../../storage/src/memory/index.js';
import { crashingStorage } from '../../../testing/src/storage/index.js';
import { makeOps } from '../../../testing/src/transport/index.js';
import { encodeCanonical } from '../../src/canonical/encode.js';
import type { Replica } from '../../src/contracts/replica.js';
import { keys } from '../../src/contracts/storage.js';
import { buildOp } from '../../src/ops/op.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { makeReplica } from './helpers.js';

const X = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
const Y = 'yyyyyyyyyyyyyyyyyyyyyyyyyy';

const docs = defineCollection({ name: 'notes', version: 1, fields: { n: f.number() } });
const other = defineCollection({ name: 'other', version: 1, fields: { n: f.number() } });

/** Builds ops of writer X with full control of collection and version. */
const opsOf = (writer: string, count: number, spec: Parameters<typeof makeOps>[2] = {}) =>
  makeOps(writer, count, spec);

async function snapshot(r: Replica) {
  const status = await r.status();
  return { hashes: await r.hashes(), vector: status.vector, pendingBuffer: status.pendingBuffer };
}

async function setup(collections = [docs, other]) {
  const backing = createMemoryBacking();
  const t = await makeReplica({ backing, collections });
  return { ...t, backing };
}

/** Reads raw storage keys through a second adapter would need the lock; use the replica's own API. */
async function pendKeys(backing: ReturnType<typeof createMemoryBacking>): Promise<string[]> {
  return backing.store.keysFrom('pend/');
}
async function opKeys(
  backing: ReturnType<typeof createMemoryBacking>,
  origin: string,
): Promise<string[]> {
  return backing.store.keysFrom(keys.opPrefix(origin));
}

describe('validation atomicity (R4.7)', () => {
  it('a valid op plus an application-schema-invalid op: the whole batch is rejected', async () => {
    const { replica } = await setup();
    const good = await opsOf(X, 1);
    const bad = await opsOf(Y, 1, { fields: () => ({ n: 'not a number' }) });
    const before = await snapshot(replica);
    for (const batch of [
      [good[0]!, bad[0]!],
      [bad[0]!, good[0]!],
    ]) {
      await expect(
        replica.endpoint().push({ replicaId: Y, support: {}, ops: batch }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(await snapshot(replica)).toEqual(before);
    }
    const unknownField = await opsOf(Y, 1, { fields: () => ({ nope: 1 }) });
    await expect(
      replica.endpoint().push({ replicaId: Y, support: {}, ops: [...good, ...unknownField] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await snapshot(replica)).toEqual(before);
  });

  it('structural, non-canonical, hash and identity failures also reject the whole batch', async () => {
    const { replica } = await setup();
    const good = await opsOf(X, 2);
    const before = await snapshot(replica);
    const variants = [
      good[1]!.replace('"n":1', '"n":7'),
      good[1]!.replace('{', '{ '),
      '{"broken":',
      good[1]!.replace('"kind":"set"', '"kind":"restore"'),
    ];
    for (const v of variants) {
      await expect(
        replica.endpoint().push({ replicaId: X, support: {}, ops: [good[0]!, v] }),
      ).rejects.toBeTruthy();
      expect(await snapshot(replica)).toEqual(before);
    }
  });
});

describe('identity across op/ and pend/ (R2.7, R15.18)', () => {
  it('duplicates of buffered and accepted ops are ignored; conflicting versions are rejected', async () => {
    const { replica, backing } = await setup();
    const ops = await opsOf(X, 3);
    const ep = replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!] });
    const r = await ep.push({ replicaId: X, support: {}, ops: [ops[2]!] });
    expect(r.need).toEqual({ [X]: 2 });
    expect(await pendKeys(backing)).toEqual([keys.pend(X, 3)]);
    const pendBefore = backing.store.get(keys.pend(X, 3));

    // (a) same op again while pending
    await ep.push({ replicaId: X, support: {}, ops: [ops[2]!] });
    expect(backing.store.get(keys.pend(X, 3))).toBe(pendBefore);
    // (b) same ID, different content while pending
    const evil = (await opsOf(X, 3, { fields: (i) => ({ n: i + 100 }) }))[2]!;
    await expect(ep.push({ replicaId: X, support: {}, ops: [evil] })).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    expect(backing.store.get(keys.pend(X, 3))).toBe(pendBefore);
    // (c) against an accepted op
    const evil1 = (await opsOf(X, 1, { fields: () => ({ n: 99 }) }))[0]!;
    await expect(ep.push({ replicaId: X, support: {}, ops: [evil1] })).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    // (d) both versions in one batch
    await expect(
      ep.push({
        replicaId: X,
        support: {},
        ops: [ops[1]!, (await opsOf(X, 2, { fields: () => ({ n: 5 }) }))[1]!],
      }),
    ).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    expect((await replica.status()).vector).toEqual({ [X]: 1 });
    // (f) the gap is filled and the surviving version is accepted
    await ep.push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect((await replica.status()).vector).toEqual({ [X]: 3 });
    expect(await pendKeys(backing)).toEqual([]);
  });

  it('concurrent delivery of identical and of conflicting versions leaves one entry', async () => {
    const { replica, backing } = await setup();
    const ops = await opsOf(X, 3);
    const evil = (await opsOf(X, 3, { fields: (i) => ({ n: i + 50 }) }))[2]!;
    const ep = replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!] });
    const same = await Promise.allSettled([
      ep.push({ replicaId: X, support: {}, ops: [ops[2]!] }),
      replica.endpoint().push({ replicaId: Y, support: {}, ops: [ops[2]!] }),
    ]);
    expect(same.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(await pendKeys(backing)).toEqual([keys.pend(X, 3)]);
    const kept = backing.store.get(keys.pend(X, 3));
    const conflicting = await Promise.allSettled([
      ep.push({ replicaId: X, support: {}, ops: [evil] }),
      ep.push({ replicaId: X, support: {}, ops: [ops[2]!] }),
    ]);
    expect(conflicting.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect(backing.store.get(keys.pend(X, 3))).toBe(kept);
  });
});

describe('copies of one op inside a batch (R5.1, R15.18)', () => {
  it('three copies of an unseen op are accepted exactly once', async () => {
    const { replica, backing } = await setup();
    const [op] = await opsOf(X, 1);
    const single = await setup();
    await single.replica.endpoint().push({ replicaId: X, support: {}, ops: [op!] });
    await replica.endpoint().push({ replicaId: X, support: {}, ops: [op!, op!, op!] });
    expect(await opKeys(backing, X)).toHaveLength(1);
    expect((await replica.status()).vector).toEqual({ [X]: 1 });
    expect(await replica.hashes()).toEqual(await single.replica.hashes());
  });

  it('three copies with a gap are buffered exactly once', async () => {
    const { replica, backing } = await setup();
    const ops = await opsOf(X, 3);
    const r = await replica
      .endpoint()
      .push({ replicaId: X, support: {}, ops: [ops[2]!, ops[2]!, ops[2]!] });
    expect(r.need).toEqual({ [X]: 1 });
    expect(await pendKeys(backing)).toEqual([keys.pend(X, 3)]);
    expect((await replica.status()).pendingBuffer).toBe(1);
  });
});

describe('pending promotion (R2.6, R15.19)', () => {
  it('op 3 before op 2, then op 2: both accepted, buffer empty, hashes as if in order', async () => {
    const { replica, backing } = await setup();
    const ordered = await setup();
    const ops = await opsOf(X, 3);
    const ep = replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!] });
    await ep.push({ replicaId: X, support: {}, ops: [ops[2]!] });
    expect((await replica.status()).pendingBuffer).toBe(1);
    const res = await replica.sync(ordered.replica.endpoint()); // no-op peer
    void res;
    const r = await ep.push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect(r.durable).toEqual({ [X]: 3 });
    expect(await pendKeys(backing)).toEqual([]);
    expect((await replica.status()).pendingBuffer).toBe(0);
    await ordered.replica.endpoint().push({ replicaId: X, support: {}, ops });
    expect((await replica.hashes()).state).toBe((await ordered.replica.hashes()).state);
    expect((await replica.hashes()).ops).toBe((await ordered.replica.hashes()).ops);
  });

  it('ops 3 and 4 before op 2 are promoted in order; a copy of a buffered op counts as a duplicate', async () => {
    const { replica, backing } = await setup();
    const ops = await opsOf(X, 4);
    const ep = replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!] });
    await ep.push({ replicaId: X, support: {}, ops: [ops[3]!, ops[2]!] });
    expect((await replica.status()).pendingBuffer).toBe(2);
    const events: string[] = [];
    const host = replica as unknown as {
      applyIncoming: Replica['endpoint'] extends never
        ? never
        : (l: string[], p: string) => Promise<{ promoted: number; duplicates: number }>;
    };
    const result = await host.applyIncoming([ops[1]!, ops[2]!], X);
    expect(result.promoted).toBe(2);
    expect(result.duplicates).toBe(1);
    expect((await replica.status()).vector).toEqual({ [X]: 4 });
    expect(await pendKeys(backing)).toEqual([]);
    void events;
    // after promotion the original ops are duplicates of accepted ops
    const again = await host.applyIncoming([ops[2]!, ops[3]!], X);
    expect(again.duplicates).toBe(2);
  });

  it('a crash around the gap-filling transaction is atomic', async () => {
    const backing = createMemoryBacking();
    const crashing = crashingStorage(memoryStorage({ backing }));
    const t = await makeReplica({ storage: crashing, collections: [docs] });
    const ops = await opsOf(X, 4);
    const ep = t.replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!, ops[2]!, ops[3]!] });
    crashing.arm({ failTransaction: () => 'before-commit' });
    await expect(ep.push({ replicaId: X, support: {}, ops: [ops[1]!] })).rejects.toBeTruthy();
    await crashing.inner.close();
    expect(backing.store.keysFrom('pend/')).toHaveLength(2);
    const after = await makeReplica({ backing, collections: [docs] });
    expect((await after.replica.status()).vector).toEqual({ [X]: 1 });
    await after.replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect((await after.replica.status()).vector).toEqual({ [X]: 4 });
    expect(backing.store.keysFrom('pend/')).toEqual([]);
  });

  it('a damaged buffer entry is dropped and requested again', async () => {
    const { replica, backing } = await setup();
    const ops = await opsOf(X, 3);
    const ep = replica.endpoint();
    await ep.push({ replicaId: X, support: {}, ops: [ops[0]!, ops[2]!] });
    backing.store.set(keys.pend(X, 3), ops[2]!.replace('"n":2', '"n":3'));
    const r = await ep.push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect(r.durable).toEqual({ [X]: 2 });
    expect(r.need).toEqual({ [X]: 3 });
    expect(backing.store.keysFrom('pend/')).toEqual([]);
    await ep.push({ replicaId: X, support: {}, ops: [ops[2]!] });
    expect((await replica.status()).vector).toEqual({ [X]: 3 });
  });

  it('pending ops do not count for vectors, hashes, contexts or lamport (design 3.5)', async () => {
    const { replica } = await setup([docs]);
    const ops = await opsOf(X, 3);
    await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[2]!] });
    const before = await replica.hashes();
    const empty = await setup([docs]);
    expect(before.ops).toBe((await empty.replica.hashes()).ops);
    const w = await replica.collection(docs).create({ n: 1 }, { mutationId: 'w' });
    const history = await replica.collection(docs).history(w.recordId);
    expect(history[0]!.context).toEqual({});
    expect(history[0]!.lamport).toBe(1);
  });
});

describe('schema-aware delivery (R4.10, R15.11)', () => {
  const v1Notes = defineCollection({ name: 'notes', version: 1, fields: { n: f.number() } });
  const v1Other = defineCollection({ name: 'other', version: 1, fields: { n: f.number() } });

  async function threeOps() {
    // op 1: notes v1, op 2: other v2 (unreadable for the receiver), op 3: notes v1
    return opsOf(X, 3, {
      collection: (i) => (i === 1 ? 'other' : 'notes'),
      schemaVersion: (i) => (i === 1 ? 2 : 1),
    });
  }

  it('(a) op 2 alone is rejected with SCHEMA_TOO_NEW and not stored', async () => {
    const { replica } = await setup([v1Notes, v1Other]);
    const ops = await threeOps();
    await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[0]!] });
    const r = await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect(r.rejected).toEqual([{ origin: X, seq: 2, code: 'SCHEMA_TOO_NEW' }]);
    expect(r.durable).toEqual({ [X]: 1 });
  });

  it('(b) ops 2 and 3 together: op 2 rejected, op 3 not stored, op 1 kept', async () => {
    const { replica, backing } = await setup([v1Notes, v1Other]);
    const ops = await threeOps();
    const r = await replica.endpoint().push({ replicaId: X, support: {}, ops });
    expect(r.durable).toEqual({ [X]: 1 });
    expect(r.rejected).toEqual([{ origin: X, seq: 2, code: 'SCHEMA_TOO_NEW' }]);
    expect(backing.store.keysFrom('pend/')).toEqual([]);
  });

  it('(c) op 3 alone follows the gap rule, without SCHEMA_TOO_NEW', async () => {
    const { replica, backing } = await setup([v1Notes, v1Other]);
    const ops = await threeOps();
    await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[0]!] });
    const before = (await replica.hashes()).ops;
    const r = await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[2]!] });
    expect(r.rejected).toEqual([]);
    expect(r.need).toEqual({ [X]: 2 });
    expect(backing.store.keysFrom('pend/')).toEqual([keys.pend(X, 3)]);
    expect((await replica.hashes()).ops).toBe(before);
    const r2 = await replica.endpoint().push({ replicaId: X, support: {}, ops: [ops[1]!] });
    expect(r2.rejected).toEqual([{ origin: X, seq: 2, code: 'SCHEMA_TOO_NEW' }]);
    expect((await replica.status()).vector).toEqual({ [X]: 1 });
  });

  it('a compliant sender delivers op 1 only, reports partial, and resumes after the upgrade', async () => {
    const v2Other = defineCollection({
      name: 'other',
      version: 2,
      fields: { n: f.number() },
      migrations: { 1: ({ fields }) => ({ ...fields }) },
    });
    const sender = await setup([v1Notes, v2Other]);
    const ops = await threeOps();
    await sender.replica.endpoint().push({ replicaId: X, support: {}, ops });
    const old = await setup([v1Notes, v1Other]);
    const result = await old.replica.sync(sender.replica.endpoint());
    expect(result.status).toBe('partial');
    expect(result.status === 'partial' && result.code).toBe('PEER_SCHEMA_OLDER');
    expect(result.blocked[0]).toMatchObject({
      origin: X,
      seq: 2,
      collection: 'other',
      requiredVersion: 2,
      direction: 'pull',
    });
    expect((await old.replica.status()).vector).toEqual({ [X]: 1 });
    // upgrade the old replica and sync again
    await old.replica.close();
    const upgraded = await makeReplica({ backing: old.backing, collections: [v1Notes, v2Other] });
    const again = await upgraded.replica.sync(sender.replica.endpoint());
    expect(again.status).toBe('complete');
    expect(await upgraded.replica.hashes()).toEqual(await sender.replica.hashes());
  });
});

void buildOp;
void encodeCanonical;
