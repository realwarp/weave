/** Tests for compaction (design 10.3) */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking } from '@weave/storage/memory';
import { makeOps } from '../../../testing/src/transport/index.js';
import { A, B, C, openRelay } from '../helpers.js';

const support = { notes: 1 };

describe('compaction', () => {
  describe('computeHorizon', () => {
    it('is the min of member acks capped by relay vector', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.ack({ replicaId: A, durable: { [A]: 10, [B]: 5 } });
      await core.ack({ replicaId: B, durable: { [A]: 8, [B]: 3 } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 8 });
    });

    it('a member that never acks keeps the horizon at 0', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: B, durable: { [A]: 5 } });

      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 5 });
    });

    it('an older ack holds the horizon there', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: B, durable: { [A]: 3 } });
      await core.ack({ replicaId: B, durable: { [A]: 5 } });

      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 5 });
    });

    it('capped by relay vector', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 5) });
      await core.ack({ replicaId: B, durable: { [A]: 10 } });
      await core.ack({ replicaId: C, durable: { [A]: 10 } });

      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 5 });
    });

    it('a removed member is excluded from horizon calculation', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: B, durable: { [A]: 8 } });
      await core.removePeer(B);

      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 10 });
    });
  });

  describe('compact', () => {
    it('gives NOT_SUPPORTED when disabled', async () => {
      const { core } = await openRelay();
      await expect(core.compact()).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('deletes exactly ops <= horizon and survives restart', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.push({ replicaId: B, support, ops: await makeOps(B, 5) });

      await core.ack({ replicaId: A, durable: { [A]: 10, [B]: 5 } });
      await core.ack({ replicaId: B, durable: { [A]: 10, [B]: 5 } });

      const horizon = await core.horizon();
      expect(horizon).toEqual({ [A]: 10, [B]: 5 });

      const result = await core.compact();
      expect(result.removedOps).toBe(15);
      expect(result.compactedThrough).toEqual({ [A]: 10, [B]: 5 });

      const stored: Array<[string, string]> = [];
      await core.storage.transaction('ro', async (tx) => {
        const cursor = await tx.scan('op/');
        for await (const [k, v] of cursor) {
          stored.push([k, v]);
        }
      });
      expect(stored).toHaveLength(0);

      backing.inUse = false;
      const { core: again } = await openRelay(backing, { compaction: { enabled: true } });
      const info = await again.compactionInfo();
      expect(info.compactedThrough).toEqual({ [A]: 10, [B]: 5 });
    });

    it('compacted state survives restart', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 5) });
      await core.ack({ replicaId: A, durable: { [A]: 5 } });
      await core.compact();

      backing.inUse = false;
      const { core: again } = await openRelay(backing, { compaction: { enabled: true } });

      expect(await again.compactionInfo().then((i) => i.compactedThrough)).toEqual({ [A]: 5 });
    });
  });

  describe('pull with compaction', () => {
    it('new member pulling from {} after compaction gets NEEDS_SNAPSHOT', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: A, durable: { [A]: 10 } });
      await core.compact();

      await expect(
        core.pull({ replicaId: A, vector: {}, support, limit: 100 }),
      ).rejects.toMatchObject({
        code: 'NEEDS_SNAPSHOT',
        details: { origin: A, compactedThrough: 10 },
      });
    });

    it('a caught-up member pulls normally', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: A, durable: { [A]: 10 } });
      await core.compact();

      const result = await core.pull({ replicaId: B, vector: { [A]: 10 }, support, limit: 100 });
      expect(result.ops).toHaveLength(0);
      expect(result.durable).toEqual({ [A]: 10 });
    });

    it('limit: 0 never throws even after compaction', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: A, durable: { [A]: 10 } });
      await core.compact();

      const result = await core.pull({ replicaId: B, vector: {}, support, limit: 0 });
      expect(result.ops).toHaveLength(0);
      expect(result.durable).toEqual({ [A]: 10 });
    });

    it('pull response includes compaction info', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.ack({ replicaId: A, durable: { [A]: 10 } });

      const result = await core.pull({ replicaId: B, vector: {}, support, limit: 0 });
      expect(result.compaction).toBeDefined();
      expect(result.compaction!.horizon).toEqual({});
      expect(result.compaction!.compactedThrough).toEqual({});
      expect(result.compaction!.removed).toEqual({});
    });
  });

  describe('removePeer', () => {
    it('refuses later pushes from removed peer', async () => {
      const { core } = await openRelay(undefined, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 5) });
      await core.removePeer(A);

      await expect(
        core.push({ replicaId: A, support, ops: await makeOps(A, 3) }),
      ).rejects.toMatchObject({
        code: 'PEER_REMOVED',
      });
    });

    it('refuses pushes of ops with seq > removedAt', async () => {
      const { core } = await openRelay(undefined, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.removePeer(A);

      await expect(
        core.push({ replicaId: A, support, ops: await makeOps(A, 3, { startSeq: 11 }) }),
      ).rejects.toMatchObject({
        code: 'PEER_REMOVED',
      });
    });

    it('is idempotent: first value kept', async () => {
      const { core } = await openRelay(undefined, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 10) });
      await core.removePeer(A);
      await core.removePeer(A);

      const info = await core.compactionInfo();
      expect(info.removed).toEqual({ [A]: 10 });
    });

    it('storage is byte-identical after removePeer and restart', async () => {
      const backing = createMemoryBacking();
      const { core } = await openRelay(backing, { compaction: { enabled: true } });

      await core.push({ replicaId: A, support, ops: await makeOps(A, 5) });
      await core.removePeer(A);

      const storage1: Array<[string, string]> = [];
      await core.storage.transaction('ro', async (tx) => {
        const cursor = await tx.scan('');
        for await (const [k, v] of cursor) {
          storage1.push([k, v]);
        }
      });
      storage1.sort();

      backing.inUse = false;
      const { core: again } = await openRelay(backing, { compaction: { enabled: true } });
      await again.removePeer(A);

      const storage2: Array<[string, string]> = [];
      await again.storage.transaction('ro', async (tx) => {
        const cursor = await tx.scan('');
        for await (const [k, v] of cursor) {
          storage2.push([k, v]);
        }
      });
      storage2.sort();

      expect(storage2).toEqual(storage1);
    });
  });
});
