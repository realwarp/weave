/**
 * [ADV] Relay membership races (PR #2 review):
 * - F3: a pull denied by the authorization hook must not leave the caller registered as a member
 *   with an empty acknowledgement (which would hold the compaction horizon at zero).
 * - F4: `removePeer` must not slip between a running push's read of the removed list and its
 *   commit, or the push stores an op that the removal should have refused (R3.10).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStorage } from '@weave/storage/memory';
import type { StorageAdapter } from '@weave/core';
import { makeOps } from '../../../testing/src/transport/index.js';
import { seededRandom } from '../../../testing/src/faults/random.js';
import { RelayCore } from '../../src/core/index.js';
import { A, B, C, openRelay } from '../helpers.js';

const support = { notes: 1 };

describe('F3: a denied pull leaves no membership behind', () => {
  it('the selection changes between the two checks and the second is denied', async () => {
    const ref: { core?: RelayCore } = {};
    let sends = 0;
    const opened = await openRelay(createMemoryBacking(), {
      compaction: { enabled: true },
      authorize: async (req) => {
        if (req.direction === 'apply') return true;
        sends++;
        if (sends === 1) {
          // Between the first selection and the second, another op arrives.
          await ref.core!.push({ replicaId: A, support, ops: (await makeOps(A, 2)).slice(1) });
          return true;
        }
        return false; // the changed selection is denied
      },
    });
    const core = opened.core;
    ref.core = core;
    await core.push({ replicaId: A, support, ops: (await makeOps(A, 2)).slice(0, 1) });
    await core.ack({ replicaId: A, durable: { [A]: 2 } });

    await expect(core.pull({ replicaId: C, vector: {}, support, limit: 10 })).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' },
    );
    expect(sends).toBe(2);
    expect(await core.memberAck(C)).toBeUndefined();
    expect(await core.horizon()).toEqual({ [A]: 2 });
  });

  it('an existing member that is denied keeps its entry unchanged', async () => {
    let allow = true;
    const { core } = await openRelay(createMemoryBacking(), {
      compaction: { enabled: true },
      authorize: (req) => req.direction === 'apply' || allow,
    });
    await core.push({ replicaId: A, support, ops: await makeOps(A, 2) });
    await core.ack({ replicaId: B, durable: { [A]: 1 } });
    allow = false;
    await expect(core.pull({ replicaId: B, vector: {}, support, limit: 10 })).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' },
    );
    expect(await core.memberAck(B)).toEqual({ [A]: 1 });
  });
});

describe('F4: removePeer cannot race a running push', () => {
  /** A storage whose next read-only transaction waits at a gate after it finishes. */
  function gated(inner: StorageAdapter) {
    let arm: { reached: () => void; release: Promise<void> } | undefined;
    const storage: StorageAdapter = {
      ...inner,
      open: () => inner.open(),
      close: () => inner.close(),
      transaction: (async (mode: 'ro' | 'rw', fn: never) => {
        const result = await (inner.transaction as (m: string, f: never) => Promise<unknown>)(
          mode,
          fn,
        );
        const a = arm;
        if (mode === 'ro' && a !== undefined) {
          arm = undefined;
          a.reached();
          await a.release;
        }
        return result;
      }) as StorageAdapter['transaction'],
    };
    const pauseNextRead = () => {
      let reached!: () => void;
      let release!: () => void;
      const reachedP = new Promise<void>((r) => (reached = r));
      const releaseP = new Promise<void>((r) => (release = r));
      arm = { reached, release: releaseP };
      return { reached: reachedP, release };
    };
    return { storage, pauseNextRead };
  }

  it('an op pushed by a peer is never stored with a seq above its removal point', async () => {
    const { storage, pauseNextRead } = gated(memoryStorage({ backing: createMemoryBacking() }));
    const core = new RelayCore({
      storage,
      random: seededRandom('relay'),
      compaction: { enabled: true },
    });
    await core.open();
    const ops = await makeOps(B, 2);
    await core.push({ replicaId: B, support, ops: ops.slice(0, 1) });

    // B's second push reads the removed list (B not removed yet), then waits.
    const gate = pauseNextRead();
    const push = core.push({ replicaId: B, support, ops: ops.slice(1) }).then(
      () => 'stored',
      (e: { code?: string }) => e.code ?? 'error',
    );
    await gate.reached;
    const removal = core.removePeer(B);
    gate.release();
    const [outcome] = await Promise.all([push, removal]);

    const info = await core.compactionInfo();
    const removedAt = info.removed[B]!;
    expect(removedAt).toBeDefined();
    const stored = (await core.vector())[B] ?? 0;
    // Either the push finished before the removal (removedAt covers it), or it was refused.
    expect(stored).toBeLessThanOrEqual(removedAt);
    if (outcome === 'stored') expect(removedAt).toBe(2);
    else expect(stored).toBe(1);
  });
});
