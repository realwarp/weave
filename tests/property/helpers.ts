/**
 * Shared helpers for the cross-package property suites (design 12.2).
 *
 * Seeds: CI runs the fixed list below. The nightly job sets `WEAVE_PROPERTY_SEEDS` to a comma list
 * of random seeds; every test name carries its seed, so a failure prints the seed to reproduce:
 *
 *   WEAVE_PROPERTY_SEEDS=123456 npx vitest run tests/property
 */
import { createReplica, type Hashes, type Replica } from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import {
  createSimulator,
  simNotesV1,
  type SimulatorOptions,
} from '../../packages/testing/src/simulator/index.js';

const FIXED = [1, 2, 3, 4, 5];

export const SEEDS: number[] = (() => {
  const env = process.env['WEAVE_PROPERTY_SEEDS'];
  if (env === undefined || env.trim() === '') return FIXED;
  return env
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n));
})();

/** fast-check settings derived from a seed, so property runs are reproducible too. */
export const fcParams = (seed: number, numRuns = 8) => ({ seed, numRuns, endOnFailure: true });

export interface Fresh {
  replica: Replica;
  backing: MemoryBacking;
  apply(lines: readonly string[]): Promise<unknown>;
}

const PEER = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';

/** An empty replica that knows the simulator's collection. */
export async function freshReplica(seed: string): Promise<Fresh> {
  const backing = createMemoryBacking();
  const replica = await createReplica({
    storage: memoryStorage({ backing }),
    collections: [simNotesV1],
    random: seededRandom(seed),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
  const engine = replica as unknown as {
    applyIncoming(lines: readonly string[], peer: string): Promise<unknown>;
  };
  return { replica, backing, apply: (lines) => engine.applyIncoming(lines, PEER) };
}

/** Runs a simulation to convergence and returns its op set and reference hashes. */
export async function simulate(options: SimulatorOptions, steps = 40) {
  const sim = await createSimulator(options);
  await sim.run(steps);
  await sim.converge();
  const converged = await sim.converged();
  const lines = sim.opLines(0);
  const hashes: Hashes = (await sim.hashes())[0]!;
  return { sim, lines, hashes, converged };
}

/** Everything a replica stores, for byte-identity checks. */
export function snapshot(backing: MemoryBacking): string {
  return JSON.stringify(backing.store.entries());
}
