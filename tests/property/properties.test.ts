/**
 * Cross-package properties (R15.1 to R15.4, R7, design 12.2). Op sets come from the simulator,
 * which runs real replicas, so contexts, Lamport values and conflicts are genuine.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toCanonical, type JsonValue } from '@weave/core/protocol';
import type { Replica } from '@weave/core';
import { arbBatches, arbJsonValue } from '../../packages/testing/src/generators/index.js';
import { seededRandom, shuffleWith } from '../../packages/testing/src/faults/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import { memoryStorage } from '@weave/storage/memory';
import { createSimulator, simNotesV1 } from '../../packages/testing/src/simulator/index.js';
import { SEEDS, fcParams, freshReplica, simulate, snapshot } from './helpers.js';

async function views(replica: Replica) {
  const col = replica.collection(simNotesV1);
  const records = await col.query({ includeDeleted: true });
  const histories: Record<string, unknown> = {};
  for (const r of records) histories[r.id] = await col.history(r.id);
  return {
    hashes: await replica.hashes(),
    current: await replica.conflicts.current(),
    history: await replica.conflicts.history(),
    histories,
  };
}

describe.each(SEEDS)('properties, seed %i', (seed) => {
  it('convergence over mesh, star, line and relay topologies', async () => {
    for (const topology of ['mesh', 'star', 'line'] as const) {
      const { sim, converged } = await simulate(
        { seed, replicas: 4, topology, weights: { offline: 2 } },
        50,
      );
      await sim.close();
      expect(converged, `${topology} seed ${seed}`).toBe(true);
    }
    const hub = new RelayCore({ storage: memoryStorage() });
    await hub.open();
    const { sim, converged } = await simulate({ seed, replicas: 3, topology: 'relay', hub }, 50);
    await sim.close();
    expect(converged, `relay seed ${seed}`).toBe(true);
  });

  it('idempotency: applying the op set twice equals applying it once', async () => {
    const { sim, lines, hashes } = await simulate({ seed, replicas: 3 });
    await sim.close();
    const fresh = await freshReplica(`idem:${seed}`);
    await fresh.apply(lines);
    const once = await fresh.replica.hashes();
    await fresh.apply(lines);
    await fresh.apply(shuffleWith(lines, seededRandom(seed)));
    expect(await fresh.replica.hashes()).toEqual(once);
    expect(once).toEqual(hashes);
  });

  it('order independence and conflict-view and op-history equality across arrival orders', async () => {
    const { sim, lines } = await simulate({
      seed,
      replicas: 3,
      weights: { write: 6, sync: 2, offline: 2 },
    });
    const reference = await views(sim.replicas[0]!.replica);
    await sim.close();
    let run = 0;
    await fc.assert(
      fc.asyncProperty(arbBatches(lines, { duplicates: true }), async (batches) => {
        const fresh = await freshReplica(`order:${seed}:${run++}`);
        for (const batch of batches) await fresh.apply(batch);
        expect((await fresh.replica.status()).pendingBuffer).toBe(0);
        expect(await views(fresh.replica)).toEqual(reference);
        await fresh.replica.close();
      }),
      fcParams(seed, 6),
    );
  });

  it('rebuild equality: rebuild() leaves all three hashes and the conflict views unchanged', async () => {
    const { sim } = await simulate({ seed, replicas: 3 });
    for (const r of sim.replicas) {
      const before = await views(r.replica);
      await r.replica.rebuild();
      expect(await views(r.replica)).toEqual(before);
    }
    await sim.close();
  });

  it('clock independence: wild wall times give the same history and hashes', async () => {
    const steady = await simulate({ seed, replicas: 3 });
    const wild = await simulate({
      seed,
      replicas: 3,
      wallTime: (step, i) => (i === 1 ? 9_000_000_000_000 - step * 1_000_003 : (step * 7919) % 5),
    });
    expect(wild.sim.log).toEqual(steady.sim.log);
    expect(wild.hashes).toEqual(steady.hashes);
    await steady.sim.close();
    await wild.sim.close();
  });

  it('supersession: a write that follows the whole frontier closes the conflict', async () => {
    // Many concurrent edits so that open field conflicts exist.
    const sim = await createSimulator({
      seed,
      replicas: 3,
      weights: { write: 8, sync: 1, offline: 0 },
      maxRecords: 2,
    });
    await sim.run(40);
    await sim.converge();
    const replica = sim.replicas[0]!.replica;
    const open = (await replica.conflicts.current()).filter((c) => c.kind === 'field');
    expect(open.length, `seed ${seed} produced no field conflict`).toBeGreaterThan(0);
    const col = replica.collection(simNotesV1);
    for (const conflict of open) {
      const record = await col.get(conflict.recordId);
      if (record === undefined) continue;
      const field = conflict.field as 'title' | 'n' | 'tags' | 'status';
      const value = { title: 'resolved', n: 1000, tags: ['resolved'], status: 'done' }[field];
      await col.update(
        conflict.recordId,
        { [field]: value },
        { mutationId: replica.newMutationId() },
      );
      const after = await replica.conflicts.current();
      expect(after.some((c) => c.conflictId === conflict.conflictId)).toBe(false);
      const logged = (await replica.conflicts.history()).find(
        (c) => c.conflictId === conflict.conflictId,
      );
      expect(logged?.status).toBe('superseded');
    }
    await sim.close();
  });

  it('batch atomicity: one invalid op anywhere leaves storage byte-identical', async () => {
    const { sim, lines } = await simulate({ seed, replicas: 3 });
    await sim.close();
    const fresh = await freshReplica(`atomic:${seed}`);
    await fresh.apply(lines.slice(0, Math.floor(lines.length / 2)));
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(lines, { minLength: 1 }),
        fc.nat(),
        fc.constantFrom('hash', 'structure', 'non-canonical'),
        async (batch, at, fault) => {
          const victim = batch[at % batch.length]!;
          const bad =
            fault === 'hash'
              ? victim.replace(/"lamport":(\d+)/, (_, n: string) => `"lamport":${Number(n) + 1}`)
              : fault === 'structure'
                ? victim.replace('"replicaId"', '"replicaID"')
                : victim.replace('{', '{ ');
          const poisoned = [...batch];
          poisoned.splice(at % (batch.length + 1), 0, bad);
          const before = snapshot(fresh.backing);
          await expect(fresh.apply(poisoned)).rejects.toBeTruthy();
          expect(snapshot(fresh.backing)).toBe(before);
        },
      ),
      fcParams(seed, 10),
    );
  });
});

describe('canonical encoding property', () => {
  const reorder = (v: JsonValue, flip: boolean): JsonValue => {
    if (Array.isArray(v)) return v.map((x) => reorder(x, flip));
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v).sort();
      if (flip) keys.reverse();
      const out: Record<string, JsonValue> = {};
      for (const k of keys) out[k] = reorder((v as Record<string, JsonValue>)[k]!, flip);
      return out;
    }
    return v;
  };

  it('key insertion order never changes the bytes', () => {
    fc.assert(
      fc.property(arbJsonValue(), (v) => {
        expect(toCanonical(reorder(v, true))).toEqual(toCanonical(reorder(v, false)));
      }),
      { seed: SEEDS[0]!, numRuns: 200 },
    );
  });

  it('unsupported values are rejected', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 60,
      '\ud800',
      { a: undefined },
      -0.0 / 0,
    ]) {
      expect(() => toCanonical(bad as JsonValue)).toThrow();
    }
  });
});
