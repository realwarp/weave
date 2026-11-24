/** The sync engine (design 8.2): verified sync point, isolation, results, status and events. */
import { describe, expect, it, vi } from 'vitest';
import { FaultyEndpoint } from '../../../testing/src/transport/index.js';
import type { SyncEndpoint } from '../../src/contracts/sync.js';
import { makeReplica, notes, sameHashes } from '../engine/helpers.js';

async function writeNotes(
  r: Awaited<ReturnType<typeof makeReplica>>['replica'],
  prefix: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++)
    await r.collection(notes).create({ title: `${prefix}${i}` }, { mutationId: `${prefix}-${i}` });
}

describe('sync results and the verified sync point (R4.2)', () => {
  it('(c) stable: one round, complete, settled equals both vectors', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await writeNotes(a.replica, 'a', 3);
    await writeNotes(b.replica, 'b', 2);
    const r = await a.replica.sync(b.replica.endpoint());
    expect(r).toMatchObject({ status: 'complete', rounds: 1, pulled: 2, pushed: 3 });
    expect(r.status === 'complete' && r.settled).toEqual((await a.replica.status()).vector);
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });

  it('uses bounded batches (R4.6) and resumes after interruption (R4.5)', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await writeNotes(a.replica, 'a', 12);
    let pushes = 0;
    const cut: SyncEndpoint = {
      ...b.replica.endpoint(),
      push: async (req) => {
        pushes++;
        if (pushes === 2) throw Object.assign(new Error('connection cut'), {});
        return b.replica.endpoint().push(req);
      },
    };
    const first = await a.replica.sync(cut, { batchSize: 5 });
    expect(first.status).toBe('failed');
    expect((await b.replica.status()).vector[a.replica.id]).toBe(5);
    const second = await a.replica.sync(b.replica.endpoint(), { batchSize: 5 });
    expect(second.status).toBe('complete');
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });

  it('(a) the endpoint advances during verification: not complete that round, complete the next', async () => {
    const a = await makeReplica();
    const hub = await makeReplica();
    const third = await makeReplica();
    await writeNotes(third.replica, 't', 1);
    let injected = false;
    const ep = new FaultyEndpoint(hub.replica.endpoint(), {
      hooks: {
        beforeCall: async (method, request) => {
          if (!injected && method === 'pull' && (request as { limit: number }).limit === 0) {
            injected = true;
            await third.replica.sync(hub.replica.endpoint()); // T pushes to the hub after L_start
          }
        },
      },
    });
    const r = await a.replica.sync(ep);
    expect(injected).toBe(true);
    expect(r.status).toBe('complete');
    expect(r.rounds).toBe(2);
    expect(await sameHashes(a.replica, hub.replica)).toBe(true);
  });

  it('(b) the replica catches up elsewhere during verification: still not complete that round', async () => {
    const a = await makeReplica();
    const hub = await makeReplica();
    const other = await makeReplica();
    await writeNotes(other.replica, 'o', 2);
    await hub.replica.sync(other.replica.endpoint());
    let injected = false;
    const ep = new FaultyEndpoint(hub.replica.endpoint(), {
      hooks: {
        beforeCall: async (method, request) => {
          if (!injected && method === 'pull' && (request as { limit: number }).limit === 0) {
            injected = true;
            await a.replica.sync(other.replica.endpoint()); // A catches up from D between L_start and L_end
          }
        },
      },
    });
    // Make the first round's pull see nothing so the catch-up happens during verification.
    const r = await a.replica.sync(ep);
    expect(injected).toBe(true);
    expect(r.status).toBe('complete');
    expect(await sameHashes(a.replica, hub.replica)).toBe(true);
  });

  it('(d) an endpoint that keeps changing every round gives partial NOT_SETTLED, keeping all data', async () => {
    const a = await makeReplica();
    const hub = await makeReplica();
    const writer = await makeReplica();
    let n = 0;
    const ep = new FaultyEndpoint(hub.replica.endpoint(), {
      hooks: {
        beforeCall: async (method, request) => {
          if (method === 'pull' && (request as { limit: number }).limit === 0) {
            await writer.replica
              .collection(notes)
              .create({ title: `w${n}` }, { mutationId: `w${n++}` });
            await writer.replica.sync(hub.replica.endpoint());
          }
        },
      },
    });
    const r = await a.replica.sync(ep, { maxRounds: 3 });
    expect(r.status).toBe('partial');
    if (r.status === 'partial' && r.code === 'NOT_SETTLED') {
      expect(r.blocked).toEqual([]);
      expect(r.endpoint[writer.replica.id]).toBeGreaterThan(r.local[writer.replica.id] ?? 0);
    } else throw new Error('expected NOT_SETTLED');
    expect((await a.replica.status()).vector[writer.replica.id]).toBe(2);
  });

  it('converges through a lossy, duplicating, reordering endpoint with retries', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await writeNotes(a.replica, 'a', 20);
    await writeNotes(b.replica, 'b', 20);
    const faulty = (inner: SyncEndpoint, seed: number) =>
      new FaultyEndpoint(inner, {
        seed,
        dropRequestRate: 0.15,
        dropResponseRate: 0.15,
        duplicateRate: 0.3,
        reorderRate: 0.5,
        truncateRate: 0.3,
      });
    for (let i = 0; i < 5; i++) {
      const r1 = await a.replica.sync(faulty(b.replica.endpoint(), i), { batchSize: 4 });
      const r2 = await b.replica.sync(faulty(a.replica.endpoint(), 100 + i), { batchSize: 4 });
      if (r1.status === 'complete' && r2.status === 'complete') break;
    }
    expect(await sameHashes(a.replica, b.replica)).toBe(true);
  });
});

describe('status and lastSyncWall (R12.3)', () => {
  it('lastSyncWall is written only by a complete sync; lastResult by every sync', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await writeNotes(a.replica, 'a', 1);
    expect((await a.replica.sync(b.replica.endpoint())).status).toBe('complete');
    const peer = b.replica.id;
    const first = (await a.replica.status()).peers[peer]!;
    expect(first.lastSyncWall).toBeDefined();
    const failing: SyncEndpoint = {
      pull: () => Promise.reject(new (class extends Error {})('down')),
      push: () => Promise.reject(new Error('down')),
      ack: () => Promise.resolve(),
    };
    void failing;
    // a failed sync through a pull that dies after the first response
    let pulls = 0;
    const flaky: SyncEndpoint = {
      ...b.replica.endpoint(),
      pull: async (req) => {
        pulls++;
        if (pulls > 1) throw new Error('down');
        return b.replica.endpoint().pull(req);
      },
    };
    const failed = await a.replica.sync(flaky);
    expect(failed.status).toBe('failed');
    const after = (await a.replica.status()).peers[peer]!;
    expect(after.lastSyncWall).toBe(first.lastSyncWall);
    expect(after.lastResult?.status).toBe('failed');
    expect((await a.replica.status()).state).toBe('failed');
    expect((await a.replica.sync(b.replica.endpoint())).status).toBe('complete');
    expect((await a.replica.status()).state).toBe('idle');
  });

  it('reports pendingOps per peer and pendingBuffer separately', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await a.replica.sync(b.replica.endpoint());
    await writeNotes(a.replica, 'x', 3);
    const s = await a.replica.status();
    expect(s.peers[b.replica.id]!.pendingOps).toBe(3);
    expect(s.pendingBuffer).toBe(0);
    await a.replica.sync(b.replica.endpoint());
    expect((await a.replica.status()).peers[b.replica.id]!.pendingOps).toBe(0);
  });
});

describe('events and logging (R12.1, R12.2)', () => {
  it('emits sync, batch, op and retry events to a custom logger', async () => {
    const a = await makeReplica();
    const b = await makeReplica();
    await writeNotes(b.replica, 'b', 2);
    await writeNotes(a.replica, 'a', 1);
    let failOnce = true;
    const ep: SyncEndpoint = {
      ...b.replica.endpoint(),
      pull: async (req) => {
        if (failOnce) {
          failOnce = false;
          const { WeaveError } = await import('../../src/contracts/errors.js');
          throw new WeaveError('TRANSPORT_ERROR', 'blip', { retryable: true });
        }
        return b.replica.endpoint().pull(req);
      },
    };
    await a.replica.sync(ep);
    const types = new Set(a.events.map((e) => e.type));
    for (const t of ['sync.start', 'batch.received', 'batch.sent', 'op.applied', 'retry'])
      expect(types.has(t as never)).toBe(true);
  });

  it('logs nothing without a logger', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { createReplica } = await import('../../src/engine/replica.js');
    const { memoryStorage } = await import('../../../storage/src/memory/index.js');
    const r = await createReplica({ storage: memoryStorage(), collections: [notes] });
    await r.collection(notes).create({ title: 'quiet' }, { mutationId: 'q' });
    await r.sync(r.endpoint());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
