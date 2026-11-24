/** [ADV] Compaction admin routes and error mapping over HTTP (T5.1). */
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { makeOps } from '../../../testing/src/transport/index.js';
import { RelayCore } from '../../src/core/index.js';
import { createRelayServer, listen } from '../../src/server/index.js';
import { A, B } from '../helpers.js';

const TOKEN = 'compaction-admin-token';
const support = { notes: 1 };

async function serve(token?: string) {
  const core = new RelayCore({ storage: memoryStorage(), compaction: { enabled: true } });
  await core.open();
  const running = await listen(
    createRelayServer({ core, ...(token === undefined ? {} : { token }) }),
    0,
  );
  return { core, url: running.url, close: async () => (await running.close(), await core.close()) };
}

const post = (url: string, path: string, body: unknown, token?: string) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('relay compaction over HTTP', () => {
  it('admin routes need the bearer token when one is set', async () => {
    const relay = await serve(TOKEN);
    try {
      expect((await post(relay.url, '/v1/admin/compact', {})).status).toBe(401);
      expect((await post(relay.url, '/v1/admin/remove-peer', { replicaId: B })).status).toBe(401);
      expect((await post(relay.url, '/v1/admin/compact', {}, TOKEN)).status).toBe(200);
      expect((await post(relay.url, '/v1/admin/remove-peer', { replicaId: B }, TOKEN)).status).toBe(
        204,
      );
      expect(
        (await post(relay.url, '/v1/admin/remove-peer', { replicaId: 'bad id' }, TOKEN)).status,
      ).toBe(400);
    } finally {
      await relay.close();
    }
  });

  it('compacts what every member holds, then a newcomer gets NEEDS_SNAPSHOT (409) as a WeaveError', async () => {
    const relay = await serve();
    try {
      const t = httpTransport({ baseUrl: relay.url });
      await t.push({ replicaId: A, support, ops: await makeOps(A, 3) });
      // A is the only member and acknowledged 1..3 by pushing them.
      const res = await post(relay.url, '/v1/admin/compact', {});
      expect(await res.json()).toMatchObject({ removedOps: 3, compactedThrough: { [A]: 3 } });
      const raw = await post(relay.url, '/v1/pull', {
        replicaId: B,
        vector: {},
        support,
        limit: 10,
      });
      expect(raw.status).toBe(409);
      expect(await raw.json()).toMatchObject({ code: 'NEEDS_SNAPSHOT' });
      await expect(t.pull({ replicaId: B, vector: {}, support, limit: 10 })).rejects.toMatchObject({
        code: 'NEEDS_SNAPSHOT',
        retryable: false,
      });
      // The pull response carries the compaction state.
      const info = (await t.pull({ replicaId: A, vector: { [A]: 3 }, support, limit: 10 }))
        .compaction;
      expect(info).toMatchObject({ compactedThrough: { [A]: 3 } });
    } finally {
      await relay.close();
    }
  });

  it('a removed member pushing gets PEER_REMOVED (409) and nothing is stored', async () => {
    const relay = await serve();
    try {
      const t = httpTransport({ baseUrl: relay.url });
      expect((await post(relay.url, '/v1/admin/remove-peer', { replicaId: B })).status).toBe(204);
      await expect(
        t.push({ replicaId: B, support, ops: await makeOps(B, 1) }),
      ).rejects.toMatchObject({
        code: 'PEER_REMOVED',
      });
      expect(await relay.core.vector()).toEqual({});
    } finally {
      await relay.close();
    }
  });
});
