/** [ADV] Relay-side snapshots (task T5.2, R4.8): store, verify and serve, over memory and HTTP. */
import { describe, expect, it } from 'vitest';
import { hashSnapshot, type Snapshot } from '@weave/core/protocol';
import { memoryStorage } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { makeOps } from '../../../testing/src/transport/index.js';
import { RelayCore } from '../../src/core/index.js';
import { createRelayServer, listen } from '../../src/server/index.js';
import { A, B } from '../helpers.js';

const support = { notes: 1 };

async function snapshotOf(
  lines: string[],
  vector: Record<string, number>,
  compactedThrough = {},
): Promise<Snapshot> {
  const body = {
    format: 'weave-snapshot/1' as const,
    source: A,
    vector,
    maxLamport: lines.length,
    compactedThrough,
    removed: {},
    ops: lines,
    archives: [],
  };
  return { ...body, hash: await hashSnapshot(body) };
}

async function relay(compaction = true) {
  const core = new RelayCore({ storage: memoryStorage(), compaction: { enabled: compaction } });
  await core.open();
  return core;
}

describe('relay snapshots', () => {
  it('serves nothing until a member uploads one', async () => {
    const core = await relay();
    await expect(core.snapshot()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const ops = await makeOps(A, 3);
    const s = await snapshotOf(ops, { [A]: 3 });
    await core.putSnapshot(s);
    expect(await core.snapshot()).toEqual(s);
  });

  it('refuses tampered or inconsistent snapshots and keeps the stored one', async () => {
    const core = await relay();
    const ops = await makeOps(A, 3);
    const good = await snapshotOf(ops, { [A]: 3 });
    await core.putSnapshot(good);
    await expect(core.putSnapshot({ ...good, maxLamport: 99 })).rejects.toMatchObject({
      code: 'INTEGRITY_CONFLICT',
    });
    await expect(
      core.putSnapshot(await snapshotOf(ops.slice(0, 2), { [A]: 3 })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const forged = ops[1]!.replace('"n":1', '"n":7');
    await expect(
      core.putSnapshot(await snapshotOf([ops[0]!, forged, ops[2]!], { [A]: 3 })),
    ).rejects.toBeTruthy();
    expect(await core.snapshot()).toEqual(good);
  });

  it('must cover the history the relay discarded', async () => {
    const core = await relay();
    await core.push({ replicaId: A, support, ops: await makeOps(A, 4) });
    expect((await core.compact()).compactedThrough).toEqual({ [A]: 4 });
    const short = await snapshotOf(await makeOps(A, 2), { [A]: 2 });
    await expect(core.putSnapshot(short)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const full = await snapshotOf(await makeOps(A, 4), { [A]: 4 });
    await core.putSnapshot(full);
    expect((await core.snapshot()).vector).toEqual({ [A]: 4 });
  });

  it('an older snapshot never replaces a newer one', async () => {
    const core = await relay();
    const ops = await makeOps(A, 4);
    await core.putSnapshot(await snapshotOf(ops, { [A]: 4 }));
    await core.putSnapshot(await snapshotOf(ops.slice(0, 2), { [A]: 2 }));
    expect((await core.snapshot()).vector).toEqual({ [A]: 4 });
  });

  it('GET and PUT /v1/snapshot over HTTP, with the token', async () => {
    const core = await relay();
    const running = await listen(createRelayServer({ core, token: 'snap-token' }), 0);
    try {
      const t = httpTransport({ baseUrl: running.url, token: 'snap-token' });
      await expect(t.snapshot!()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
      const s = await snapshotOf(await makeOps(B, 2), { [B]: 2 });
      await t.putSnapshot!(s);
      expect(await t.snapshot!()).toEqual(s);
      const noToken = await fetch(`${running.url}/v1/snapshot`);
      expect(noToken.status).toBe(401);
    } finally {
      await running.close();
      await core.close();
    }
  });
});
