/**
 * Relay end to end (task T2.3, R4a.10, R15.1, R15.4, R15.11, R15.16, R15.18): a real `weave-relay`
 * process, the HTTP transport, and replicas.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { keys, readEnvelope } from '@weave/core/protocol';
import { fileStorage } from '@weave/storage/file';
import { createMemoryBacking, memoryStorage } from '@weave/storage/memory';
import { encodePushRequest, httpTransport } from '@weave/transport/http';
import { makeOps } from '../../packages/testing/src/transport/index.js';
import { simNotesV1, simNotesV2 } from '../../packages/testing/src/simulator/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import { cleanTemps, device, restartAfterKill, startRelayProcess, tempDir } from './helpers.js';

afterAll(cleanTemps);

const TOKEN = 'relay-e2e-token-5c1f';
const notes = simNotesV1;
const push = (url: string, replicaId: string, ops: string[], token?: string) =>
  fetch(`${url}/v1/push`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: encodePushRequest({ replicaId, support: { notes: 2 }, ops }),
  });

describe('weave-relay process end to end', () => {
  it(
    'three replicas converge through the relay, also across a graceful restart',
    { timeout: 60_000 },
    async () => {
      const dir = tempDir('three');
      let relay = await startRelayProcess(dir, { token: TOKEN });
      const t = () => httpTransport({ baseUrl: relay.url, token: TOKEN });
      const [a, b, c] = [await device('a'), await device('b'), await device('c')];
      try {
        const { recordId } = await a
          .collection(notes)
          .create({ title: 'base' }, { mutationId: 'a1' });
        for (const r of [a, b, c]) expect((await r.sync(t())).status).toBe('complete');
        await a
          .collection(notes)
          .update(recordId, { title: 'A', n: 1, tags: ['a'] }, { mutationId: 'a2' });
        await b
          .collection(notes)
          .update(recordId, { title: 'B', n: 5, tags: ['b'] }, { mutationId: 'b1' });
        await c.collection(notes).delete(recordId, { mutationId: 'c1' });
        await a.sync(t());
        await relay.stop('SIGTERM');
        relay = await startRelayProcess(dir, { token: TOKEN });
        for (let i = 0; i < 2; i++)
          for (const r of [a, b, c]) expect((await r.sync(t())).status).toBe('complete');
        const h = await Promise.all([a, b, c].map((r) => r.hashes()));
        expect(h[1]).toEqual(h[0]);
        expect(h[2]).toEqual(h[0]);
        expect(relay.output()).not.toContain(TOKEN);
      } finally {
        await relay.stop();
      }
    },
  );

  it('SIGKILL loses nothing the relay acknowledged', { timeout: 60_000 }, async () => {
    const dir = tempDir('kill');
    const relay = await startRelayProcess(dir);
    const W = 'wwwwwwwwwwwwwwwwwwwwwwwwww';
    const ops = await makeOps(W, 400);
    let acknowledged = 0;
    let sent = 0;
    const pusher = (async () => {
      for (; sent < ops.length; sent += 5) {
        const res = await push(relay.url, W, ops.slice(sent, sent + 5)).catch(() => undefined);
        if (res === undefined || res.status !== 200) return;
        const body = (await res.json()) as { durable: Record<string, number> };
        acknowledged = Math.max(acknowledged, body.durable[W] ?? 0);
      }
    })();
    while (acknowledged < 50) await new Promise((r) => setTimeout(r, 5));
    await relay.stop('SIGKILL');
    await pusher;
    const { relay: again, mode } = await restartAfterKill(dir);
    try {
      expect(['takeover', 'manual-recovery']).toContain(mode);
      const pulled = await httpTransport({ baseUrl: again.url }).pull({
        replicaId: 'pppppppppppppppppppppppppp',
        vector: {},
        support: { notes: 1 },
        limit: 0,
      });
      const held = pulled.durable[W] ?? 0;
      expect(held).toBeGreaterThanOrEqual(acknowledged);
      expect(held % 5).toBe(0); // whole pushes only
      // The relay keeps working after recovery.
      const rest = await push(again.url, W, ops.slice(held, held + 5));
      expect(rest.status).toBe(200);
    } finally {
      await again.stop();
    }
  });

  it(
    'concurrent pushes of one op ID: identical once, different keeps the first',
    { timeout: 60_000 },
    async () => {
      const dir = tempDir('race');
      const relay = await startRelayProcess(dir);
      const W = 'vvvvvvvvvvvvvvvvvvvvvvvvvv';
      try {
        for (let seq = 1; seq <= 10; seq++) {
          const same = await makeOps(W, 1, { startSeq: seq, fields: () => ({ title: `s${seq}` }) });
          const statuses = await Promise.all([
            push(relay.url, W, same),
            push(relay.url, W, same),
          ]).then((rs) =>
            Promise.all(
              rs.map(
                async (r) =>
                  [r.status, (await r.json()) as { durable: Record<string, number> }] as const,
              ),
            ),
          );
          expect(statuses.map(([s]) => s)).toEqual([200, 200]);
          expect(statuses.map(([, b]) => b.durable[W])).toEqual([seq, seq]);
        }
        for (let seq = 11; seq <= 20; seq++) {
          const x = await makeOps(W, 1, { startSeq: seq, fields: () => ({ title: 'x' }) });
          const y = await makeOps(W, 1, { startSeq: seq, fields: () => ({ title: 'y' }) });
          const offset = seq % 3;
          const results = await Promise.all([
            push(relay.url, W, x),
            new Promise<Response>((r) => setTimeout(() => r(push(relay.url, W, y)), offset)),
          ]);
          const codes = await Promise.all(
            results.map(async (r) => [r.status, await r.json()] as const),
          );
          expect(codes.map(([s]) => s).sort()).toEqual([200, 400]);
          expect(codes.find(([s]) => s === 400)![1]).toMatchObject({ code: 'INTEGRITY_CONFLICT' });
        }
      } finally {
        await relay.stop();
      }
      // The stored ops are the winners; identical pushes were stored once.
      const core = new RelayCore({ storage: fileStorage({ dir }) });
      await core.open();
      expect(await core.vector()).toEqual({ [W]: 20 });
      expect(await core.memberAck(W)).toEqual({ [W]: 20 });
      const stored = await core.storage.transaction('ro', (tx) => tx.scan(keys.opPrefix(W)));
      expect(stored).toHaveLength(20);
      await core.close();
    },
  );

  it('schema-aware delivery through the relay (R15.11)', { timeout: 60_000 }, async () => {
    const relay = await startRelayProcess(tempDir('schema'));
    const t = () => httpTransport({ baseUrl: relay.url });
    try {
      const backing = createMemoryBacking();
      let writer = await device('writer', [simNotesV1], memoryStorage({ backing }));
      await writer.collection(simNotesV1).create({ title: 'v1 note' }, { mutationId: 'w1' });
      await writer.close();
      writer = await device('writer-v2', [simNotesV2], memoryStorage({ backing }));
      await writer
        .collection(simNotesV2)
        .create({ title: 'v2 note', note: 'new' }, { mutationId: 'w2' });
      expect((await writer.sync(t())).status).toBe('complete');

      const oldBacking = createMemoryBacking();
      let reader = await device('reader', [simNotesV1], memoryStorage({ backing: oldBacking }));
      const partial = await reader.sync(t());
      expect(partial).toMatchObject({ status: 'partial', code: 'PEER_SCHEMA_OLDER' });
      expect((await reader.collection(simNotesV1).query()).map((r) => r.value.title)).toEqual([
        'v1 note',
      ]);
      await reader.close();
      reader = await device('reader-v2', [simNotesV2], memoryStorage({ backing: oldBacking }));
      expect((await reader.sync(t())).status).toBe('complete');
      expect(await reader.hashes()).toEqual(await writer.hashes());
    } finally {
      await relay.stop();
    }
  });

  it(
    'push and pull isolation: a bad origin is rejected, the good origin is delivered',
    { timeout: 60_000 },
    async () => {
      const relay = await startRelayProcess(tempDir('isolation'));
      const t = () => httpTransport({ baseUrl: relay.url });
      try {
        // Pull side: the relay is opaque, so it stores a schema-invalid op from Y (title is a number).
        const X = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
        const Y = 'yyyyyyyyyyyyyyyyyyyyyyyyyy';
        expect(
          (await push(relay.url, X, await makeOps(X, 2, { fields: (i) => ({ title: `x${i}` }) })))
            .status,
        ).toBe(200);
        expect(
          (await push(relay.url, Y, await makeOps(Y, 1, { fields: () => ({ title: 5 }) }))).status,
        ).toBe(200);
        const r = await device('isolated-reader');
        const pulled = await r.sync(t());
        expect(pulled.status).toBe('failed');
        expect(pulled.rejectedOrigins).toEqual([
          { origin: Y, direction: 'pull', code: 'VALIDATION_FAILED' },
        ]);
        expect((await r.status()).vector).toEqual({ [X]: 2 });

        // Push side: S holds a damaged copy of an op of origin Z; the relay rejects only Z.
        const z = await device('z');
        await z.collection(notes).create({ title: 'z' }, { mutationId: 'z1' });
        const backing = createMemoryBacking();
        const s = await device('s', [simNotesV1], memoryStorage({ backing }));
        await s.sync(z.endpoint());
        await s.collection(notes).create({ title: 's own' }, { mutationId: 's1' });
        const key = keys.op(z.id, 1);
        backing.store.set(key, backing.store.get(key)!.replace('"title":"z"', '"title":"Z"'));
        const pushed = await s.sync(t());
        expect(pushed.status).toBe('failed');
        expect(pushed.rejectedOrigins).toContainEqual(
          expect.objectContaining({ origin: z.id, direction: 'push' }),
        );
        const held = await t().pull({
          replicaId: 'qqqqqqqqqqqqqqqqqqqqqqqqqq',
          vector: {},
          support: { notes: 1 },
          limit: 0,
        });
        expect(held.durable[s.id]).toBe(1);
        expect(held.durable[z.id]).toBeUndefined();
      } finally {
        await relay.stop();
      }
    },
  );

  it('token, limits and log redaction on the real process', { timeout: 60_000 }, async () => {
    const relay = await startRelayProcess(tempDir('limits'), { token: TOKEN });
    const W = 'uuuuuuuuuuuuuuuuuuuuuuuuuu';
    try {
      expect((await fetch(`${relay.url}/v1/health`)).status).toBe(200);
      expect((await push(relay.url, W, await makeOps(W, 1))).status).toBe(401);
      expect((await push(relay.url, W, await makeOps(W, 1), 'wrong')).status).toBe(401);
      const tooMany = await push(relay.url, W, await makeOps(W, 501), TOKEN);
      expect(tooMany.status).toBe(400);
      expect(await tooMany.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      const huge = await fetch(`${relay.url}/v1/push`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: 'x'.repeat(5 * 1024 * 1024),
      });
      expect(huge.status).toBe(413);
      expect((await push(relay.url, W, await makeOps(W, 3), TOKEN)).status).toBe(200);
      expect(relay.output()).not.toContain(TOKEN);
      expect(relay.output()).toMatch(/POST \/v1\/push 401/);
    } finally {
      await relay.stop();
    }
  });

  it('acknowledgement cases survive a relay restart', { timeout: 60_000 }, async () => {
    const dir = tempDir('acks');
    let relay = await startRelayProcess(dir);
    const t = () => httpTransport({ baseUrl: relay.url });
    const [pusher, puller] = [await device('pusher'), await device('puller')];
    await pusher.collection(notes).create({ title: 'p' }, { mutationId: 'p1' });
    await pusher.collection(notes).create({ title: 'q' }, { mutationId: 'p2' });
    expect((await pusher.sync(t())).status).toBe('complete');
    // A pull that is never acknowledged (the puller "crashes" before acking).
    const raw = await t().pull({
      replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrrrr',
      vector: {},
      support: { notes: 1 },
      limit: 100,
    });
    expect(raw.ops).toHaveLength(2);
    expect((await puller.sync(t())).status).toBe('complete');
    await relay.stop('SIGTERM');

    const core = new RelayCore({ storage: fileStorage({ dir }) });
    await core.open();
    expect(await core.memberAck(pusher.id)).toEqual({ [pusher.id]: 2 });
    expect(await core.memberAck(puller.id)).toEqual({ [pusher.id]: 2 });
    expect(await core.memberAck('rrrrrrrrrrrrrrrrrrrrrrrrrr')).toEqual({});
    await core.close();

    relay = await startRelayProcess(dir);
    try {
      expect((await puller.sync(t())).status).toBe('complete');
      expect(raw.ops.map((l) => readEnvelope(l).seq)).toEqual([1, 2]);
    } finally {
      await relay.stop();
    }
  });
});
