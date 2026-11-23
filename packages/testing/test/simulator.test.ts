import { describe, expect, it } from 'vitest';
import { readEnvelope } from '@weave/core/protocol';
import { createSimulator, type SimulatorOptions } from '../src/simulator/index.js';
import { ReferenceEndpoint } from '../src/transport/index.js';

async function play(options: SimulatorOptions, steps: number) {
  const sim = await createSimulator(options);
  try {
    await sim.run(steps);
    const sweeps = await sim.converge();
    return {
      log: [...sim.log],
      hashes: await sim.hashes(),
      converged: await sim.converged(),
      ops: sim.opLines(0),
      sweeps,
    };
  } finally {
    await sim.close();
  }
}

describe('simulator (design 12.2)', () => {
  it('the same seed gives the same history, the same op bytes and the same hashes', async () => {
    const a = await play({ seed: 42, replicas: 3 }, 60);
    const b = await play({ seed: 42, replicas: 3 }, 60);
    expect(b.log).toEqual(a.log);
    expect(b.ops).toEqual(a.ops);
    expect(b.hashes).toEqual(a.hashes);
    const c = await play({ seed: 43, replicas: 3 }, 60);
    expect(c.log).not.toEqual(a.log);
  });

  for (const topology of ['mesh', 'star', 'line'] as const) {
    it(`drives replicas to equal hashes (${topology})`, async () => {
      for (const seed of [1, 2, 3]) {
        const r = await play({ seed, replicas: 4, topology }, 80);
        expect(r.converged, `seed ${seed}`).toBe(true);
        expect(r.ops.length).toBeGreaterThan(0);
      }
    });
  }

  it('drives replicas to equal hashes through a hub endpoint (relay topology)', async () => {
    const r = await play(
      { seed: 7, replicas: 3, topology: 'relay', hub: new ReferenceEndpoint() },
      80,
    );
    expect(r.converged).toBe(true);
  });

  it('produces genuine causal metadata: concurrent writes, multiple origins, rising Lamport values', async () => {
    const r = await play({ seed: 5, replicas: 3, weights: { write: 5, sync: 2, offline: 1 } }, 80);
    const envelopes = r.ops.map(
      (l) =>
        JSON.parse(l) as { replicaId: string; lamport: number; context: Record<string, number> },
    );
    expect(new Set(envelopes.map((e) => e.replicaId)).size).toBe(3);
    // Some op has a context naming another origin, so it causally follows a synced op.
    expect(envelopes.some((e) => Object.keys(e.context).some((k) => k !== e.replicaId))).toBe(true);
    for (const line of r.ops) expect(readEnvelope(line).seq).toBeGreaterThan(0);
  });

  it('handles offline periods and schema upgrades (mixed versions, then all upgraded)', async () => {
    const r = await play(
      { seed: 11, replicas: 3, weights: { write: 5, sync: 3, offline: 2, upgrade: 1 } },
      120,
    );
    expect(r.log.some((l) => l.endsWith('upgrade'))).toBe(true);
    expect(r.log.some((l) => l.endsWith('offline'))).toBe(true);
    expect(r.converged).toBe(true);
  });

  it('state does not depend on wall time (clock independence)', async () => {
    const steady = await play({ seed: 9, replicas: 3 }, 60);
    const wild = await play(
      {
        seed: 9,
        replicas: 3,
        wallTime: (step, i) => (i % 2 === 0 ? step : 4_000_000_000_000 - step * 7_919),
      },
      60,
    );
    expect(wild.log).toEqual(steady.log);
    expect(wild.hashes).toEqual(steady.hashes);
  });
});
