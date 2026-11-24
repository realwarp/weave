import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keys, readEnvelope, type StorageAdapter } from '@weave/core/protocol';
import { createMemoryBacking, memoryStorage } from '@weave/storage/memory';
import { crashingStorage } from '../../../testing/src/storage/index.js';
import { makeOps } from '../../../testing/src/transport/index.js';
import { RelayCore } from '../../src/core/index.js';
import { A, B, C, openRelay } from '../helpers.js';

const support = { notes: 1 };

describe('RelayCore push and pull', () => {
  it('stores op lines byte for byte and returns them in order', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(A, 5, { fields: (i) => ({ t: `caf\u00e9 ${i}` }) });
    const r = await core.push({ replicaId: A, support, ops });
    expect(r).toEqual({ durable: { [A]: 5 }, rejected: [], need: {}, blocked: [] });
    const pulled = await core.pull({ replicaId: B, vector: {}, support, limit: 100 });
    expect(pulled.ops).toEqual(ops);
    expect(pulled.durable).toEqual({ [A]: 5 });
    expect(pulled.support).toBe('*');
    expect(pulled.more).toBe(false);
    const stored = await core.storage.transaction('ro', (tx) => tx.get(keys.op(A, 3)));
    expect(stored).toBe(ops[2]);
  });

  it('pull honours limit, limit 0 and origins', async () => {
    const { core } = await openRelay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 4) });
    await core.push({ replicaId: B, support, ops: await makeOps(B, 3) });
    const page = await core.pull({ replicaId: C, vector: {}, support, limit: 2 });
    expect(page.ops).toHaveLength(2);
    expect(page.more).toBe(true);
    const zero = await core.pull({ replicaId: C, vector: {}, support, limit: 0 });
    expect(zero.ops).toEqual([]);
    expect(zero.durable).toEqual({ [A]: 4, [B]: 3 });
    const onlyB = await core.pull({ replicaId: C, vector: {}, support, limit: 100, origins: [B] });
    expect(onlyB.ops.map((l) => readEnvelope(l).replicaId)).toEqual([B, B, B]);
    const rest = await core.pull({ replicaId: C, vector: { [A]: 2 }, support, limit: 100 });
    expect(
      rest.ops.filter((l) => readEnvelope(l).replicaId === A).map((l) => readEnvelope(l).seq),
    ).toEqual([3, 4]);
  });

  it('pull stops an origin at the first op the puller cannot read (prefix rule)', async () => {
    const { core } = await openRelay();
    await core.push({
      replicaId: A,
      support,
      ops: await makeOps(A, 4, { schemaVersion: (i) => (i === 2 ? 2 : 1) }),
    });
    const r = await core.pull({ replicaId: B, vector: {}, support, limit: 100 });
    expect(r.ops.map((l) => readEnvelope(l).seq)).toEqual([1, 2]);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]).toMatchObject({ origin: A, seq: 3, requiredVersion: 2 });
  });

  it('duplicates are idempotent and gaps are reported in need', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(A, 5);
    await core.push({ replicaId: A, support, ops: ops.slice(0, 2) });
    const again = await core.push({ replicaId: A, support, ops: ops.slice(0, 2) });
    expect(again.durable).toEqual({ [A]: 2 });
    const gap = await core.push({ replicaId: A, support, ops: [ops[3]!, ops[4]!] });
    expect(gap.durable).toEqual({ [A]: 2 });
    expect(gap.need).toEqual({ [A]: 3 });
    expect(await core.vector()).toEqual({ [A]: 2 });
  });

  it('rejects the whole push when any line is invalid or conflicts', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(A, 3);
    const tampered = ops[1]!.replace('"n":1', '"n":9');
    await expect(
      core.push({ replicaId: A, support, ops: [ops[0]!, tampered] }),
    ).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    expect(await core.vector()).toEqual({});
    await core.push({ replicaId: A, support, ops });
    const other = await makeOps(A, 1, { fields: () => ({ n: 'other' }) });
    await expect(core.push({ replicaId: A, support, ops: other })).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
      details: { status: 'REPLICA_ID_REUSE' },
    });
    const stored = await core.storage.transaction('ro', (tx) => tx.get(keys.op(A, 1)));
    expect(stored).toBe(ops[0]);
  });

  it('enforces the op and push limits', async () => {
    const { core } = await openRelay(undefined, { limits: { maxOpsPerPush: 2, maxOpBytes: 400 } });
    await expect(
      core.push({ replicaId: A, support, ops: await makeOps(A, 3) }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const big = await makeOps(A, 1, { fields: () => ({ t: 'x'.repeat(1000) }) });
    await expect(core.push({ replicaId: A, support, ops: big })).rejects.toBeTruthy();
    expect(await core.vector()).toEqual({});
  });

  it('acknowledges a push only after the commit (durable before acknowledge)', async () => {
    const backing = createMemoryBacking();
    const ops = await makeOps(A, 2);
    // A crashed storage stays dead, like a killed process; each round restarts on the same backing.
    const crashOnCommit = async (point: 'before-commit' | 'after-commit') => {
      backing.inUse = false;
      const storage = crashingStorage(memoryStorage({ backing }));
      const core = new RelayCore({ storage });
      await core.open();
      // Transaction 0 registers the member; transaction 1 commits the ops.
      storage.arm({ failTransaction: (i) => (i === 1 ? point : undefined) });
      await expect(core.push({ replicaId: A, support, ops })).rejects.toMatchObject({
        details: { simulatedCrash: true },
      });
    };
    const restart = async () => {
      backing.inUse = false;
      return (await openRelay(backing)).core;
    };

    await crashOnCommit('before-commit');
    let core = await restart();
    expect(await core.vector()).toEqual({});
    expect(await core.memberAck(A)).toEqual({});

    // A crash after the commit loses only the response; the retry is an idempotent duplicate.
    await crashOnCommit('after-commit');
    core = await restart();
    expect(await core.vector()).toEqual({ [A]: 2 });
    expect((await core.push({ replicaId: A, support, ops })).durable).toEqual({ [A]: 2 });
  });

  it('keeps its identity and data across a restart', async () => {
    const { core, backing } = await openRelay();
    const id = core.endpointId;
    await core.push({ replicaId: A, support, ops: await makeOps(A, 3) });
    await core.close();
    const { core: again } = await openRelay(backing);
    expect(again.endpointId).toBe(id);
    expect(await again.vector()).toEqual({ [A]: 3 });
  });
});

describe('RelayCore concurrent pushes of one op ID', () => {
  /**
   * Storage that forces the worst interleaving: each commit transaction (the third read-write
   * transaction onwards; the first two register the members) waits until both pushes have done
   * their read-only identity check, or 50 ms when the queue serializes them.
   */
  function racingStorage(): StorageAdapter & { arm(): void } {
    const inner = memoryStorage();
    let armed = false;
    let rw = 0;
    let ro = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((r) => (release = r));
    return {
      arm: () => void (armed = true),
      open: () => inner.open(),
      close: () => inner.close(),
      async transaction(mode, fn) {
        if (!armed) return inner.transaction(mode, fn);
        if (mode === 'ro') {
          const out = await inner.transaction(mode, fn);
          if (++ro >= 2) release();
          return out;
        }
        if (++rw > 2) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 50))]);
        return inner.transaction(mode, fn);
      },
    };
  }

  async function race(options: { unsafeDisableQueue?: boolean; unsafeDisableRecheck?: boolean }) {
    const storage = racingStorage();
    const core = new RelayCore({ storage, ...options });
    await core.open();
    storage.arm();
    const first = await makeOps(A, 1, { fields: () => ({ v: 'first' }) });
    const second = await makeOps(A, 1, { fields: () => ({ v: 'second' }) });
    const results = await Promise.allSettled([
      core.push({ replicaId: A, support, ops: first }),
      core.push({ replicaId: A, support, ops: second }),
    ]);
    const stored = await core.storage.transaction('ro', (tx) => tx.get(keys.op(A, 1)));
    return { results, stored, first: first[0]!, second: second[0]! };
  }

  for (const options of [{}, { unsafeDisableQueue: true }, { unsafeDisableRecheck: true }]) {
    it(`stores exactly one version and acknowledges only that one (${JSON.stringify(options)})`, async () => {
      const { results, stored, first, second } = await race(options);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok).toHaveLength(1);
      const winner = results[0]!.status === 'fulfilled' ? first : second;
      expect(stored).toBe(winner);
    });
  }

  it('with both protections disabled the race is observable (the test can fail)', async () => {
    const { results, stored, first } = await race({
      unsafeDisableQueue: true,
      unsafeDisableRecheck: true,
    });
    // Both pushes are acknowledged, but only one version can be stored: an acknowledged op was lost.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(stored).not.toBe(first);
  });
});

describe('relay opacity (R4a.2)', () => {
  it('imports no resolver, schema, migration or state code', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    const allowed =
      /^(node:|\.\.?\/|@weave\/core\/protocol$|@weave\/storage\/file$|@weave\/transport\/http$)/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/from\s+'([^']+)'/g)) {
        expect(m[1], `${file} imports ${m[1]}`).toMatch(allowed);
        expect(m[1]).not.toMatch(/resolver|schema|migrat|state|engine/);
      }
    }
  });
});
