/**
 * The property and scenario suites against the FILE adapter (task T2.2, R9.3, R15.17). Every
 * replica stores its data in a real directory, and every reopen goes through the journal.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { createReplica, type Replica } from '@weave/core';
import { fileStorage } from '@weave/storage/file';
import {
  fakeClock,
  fakeScheduler,
  seededRandom,
} from '../../../packages/testing/src/faults/index.js';
import { arbBatches } from '../../../packages/testing/src/generators/index.js';
import { createSimulator, simNotesV1 } from '../../../packages/testing/src/simulator/index.js';
import { SEEDS, fcParams, simulate } from '../../property/helpers.js';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `weave-fa-${name}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PEER = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';

async function fileReplica(dir: string, seed: string) {
  const replica = await createReplica({
    storage: fileStorage({ dir }),
    collections: [simNotesV1],
    random: seededRandom(seed),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
  const engine = replica as unknown as {
    applyIncoming(l: readonly string[], p: string): Promise<unknown>;
  };
  return { replica, apply: (lines: readonly string[]) => engine.applyIncoming(lines, PEER) };
}

/** Name and SHA-256 of every file in a data directory. */
function dirDigest(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map(
      (name) =>
        `${name}:${createHash('sha256')
          .update(readFileSync(join(dir, name)))
          .digest('hex')}`,
    )
    .join('\n');
}

async function views(replica: Replica) {
  const col = replica.collection(simNotesV1);
  const histories: Record<string, unknown> = {};
  for (const r of await col.query({ includeDeleted: true }))
    histories[r.id] = await col.history(r.id);
  return {
    hashes: await replica.hashes(),
    current: await replica.conflicts.current(),
    history: await replica.conflicts.history(),
    histories,
  };
}

const seeds = SEEDS.slice(0, 3);

describe.each(seeds)('file adapter properties, seed %i', (seed) => {
  it('storage independence: file-backed simulation equals the memory one, step by step', async () => {
    const memory = await simulate({ seed, replicas: 3, weights: { offline: 1, upgrade: 1 } }, 40);
    const root = temp(`sim-${seed}`);
    const sim = await createSimulator({
      seed,
      replicas: 3,
      weights: { offline: 1, upgrade: 1 },
      storage: (name) => fileStorage({ dir: join(root, name), rotateBytes: 4096 }),
    });
    await sim.run(40);
    await sim.converge();
    expect(sim.log).toEqual(memory.sim.log);
    expect(await sim.converged()).toBe(true);
    expect((await sim.hashes())[0]).toEqual(memory.hashes);
    await sim.close();
    await memory.sim.close();
  });

  it('convergence over line and star topologies on file storage', async () => {
    for (const topology of ['line', 'star'] as const) {
      const root = temp(`topo-${seed}`);
      const sim = await createSimulator({
        seed,
        replicas: 3,
        topology,
        storage: (name) => fileStorage({ dir: join(root, name) }),
      });
      await sim.run(30);
      await sim.converge();
      expect(await sim.converged(), topology).toBe(true);
      await sim.close();
    }
  });

  it('idempotency, rebuild equality and survival across reopen', async () => {
    const { sim, lines, hashes } = await simulate({ seed, replicas: 3 });
    const reference = await views(sim.replicas[0]!.replica);
    await sim.close();
    const dir = temp(`idem-${seed}`);
    let r = await fileReplica(dir, `idem:${seed}`);
    await r.apply(lines);
    await r.apply(lines);
    expect(await r.replica.hashes()).toEqual(hashes);
    await r.replica.rebuild();
    expect(await views(r.replica)).toEqual(reference);
    await r.replica.close();
    r = await fileReplica(dir, `idem:${seed}:reopen`);
    expect(await views(r.replica)).toEqual(reference);
    await r.replica.close();
  });

  it('order independence through the pending buffer, with restarts between batches', async () => {
    const { sim, lines } = await simulate({
      seed,
      replicas: 3,
      weights: { write: 6, sync: 2, offline: 2 },
    });
    const reference = await views(sim.replicas[0]!.replica);
    await sim.close();
    let run = 0;
    await fc.assert(
      fc.asyncProperty(arbBatches(lines, { duplicates: true, maxBatches: 4 }), async (batches) => {
        const dir = temp(`order-${seed}`);
        const id = `order:${seed}:${run++}`;
        for (const [i, batch] of batches.entries()) {
          const r = await fileReplica(dir, `${id}:${i}`);
          await r.apply(batch);
          await r.replica.close();
        }
        const r = await fileReplica(dir, `${id}:final`);
        expect((await r.replica.status()).pendingBuffer).toBe(0);
        expect(await views(r.replica)).toEqual(reference);
        await r.replica.close();
      }),
      fcParams(seed, 3),
    );
  });

  it('batch atomicity: a rejected batch leaves every data file byte-identical', async () => {
    const { sim, lines } = await simulate({ seed, replicas: 3 });
    await sim.close();
    const dir = temp(`atomic-${seed}`);
    const r = await fileReplica(dir, `atomic:${seed}`);
    await r.apply(lines.slice(0, Math.floor(lines.length / 2)));
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(lines, { minLength: 1 }),
        fc.nat(),
        async (batch, at) => {
          const victim = batch[at % batch.length]!;
          const bad = victim.replace(
            /"lamport":(\d+)/,
            (_, n: string) => `"lamport":${Number(n) + 1}`,
          );
          const poisoned = [...batch];
          poisoned.splice(at % (batch.length + 1), 0, bad);
          const before = dirDigest(dir);
          await expect(r.apply(poisoned)).rejects.toBeTruthy();
          expect(dirDigest(dir)).toBe(before);
        },
      ),
      fcParams(seed, 5),
    );
    await r.replica.close();
  });
});
