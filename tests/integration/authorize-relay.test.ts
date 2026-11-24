/**
 * [ADV] Authorization end to end (T5.6, R16.3, R16.4): real replicas sync through a relay, once
 * over HTTP (the server maps each bearer secret to a trusted identity) and once in process
 * (`RelayCore.endpoint({ auth })`). The two paths must give the same results: allowed origins
 * progress, an origin the caller may not write is quarantined as UNAUTHORIZED, a caller that
 * spoofs another replica's ID changes nothing, and with nothing configured sync is 0.1.0 sync.
 */
import { describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f, type Replica } from '@weave/core';
import type { AuthContext, AuthorizeHook, SyncEndpoint, SyncResult } from '@weave/core/protocol';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { inProcessTransport } from '@weave/transport/in-process';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { RelayCore } from '../../packages/relay/src/core/index.js';
import {
  createRelayServer,
  listen,
  type RelayIdentity,
} from '../../packages/relay/src/server/index.js';

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });
let n = 0;
const device = (): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [notes],
    random: seededRandom(`authrelay-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
let m = 0;
const write = async (r: Replica, count: number) => {
  for (let i = 0; i < count; i++)
    await r.collection(notes).create({ title: `t${i}` }, { mutationId: `ar-${m++}` });
};

type Mode = 'http' | 'in-process';

interface Setup {
  /** The relay as seen by the holder of `identity`. */
  as(identity: RelayIdentity): SyncEndpoint;
  backing: MemoryBacking;
  close(): Promise<void>;
}

async function relay(
  mode: Mode,
  identities: RelayIdentity[],
  authorize?: AuthorizeHook,
): Promise<Setup> {
  const backing = createMemoryBacking();
  const core = new RelayCore({
    storage: memoryStorage({ backing }),
    ...(authorize === undefined ? {} : { authorize }),
  });
  await core.open();
  if (mode === 'in-process') {
    const authOf = (i: RelayIdentity): AuthContext => ({
      principal: i.principal,
      writableAs: i.writableAs,
    });
    return {
      as: (i) => inProcessTransport(core.endpoint({ auth: authOf(i) })),
      backing,
      close: () => core.close(),
    };
  }
  const running = await listen(createRelayServer({ core, identities }), 0);
  return {
    as: (i) => httpTransport({ baseUrl: running.url, token: i.token }),
    backing,
    close: async () => {
      await running.close();
      await core.close();
    },
  };
}

const summary = (r: SyncResult) => ({
  status: r.status,
  code: r.status === 'complete' ? null : r.code,
  rejected: r.rejectedOrigins.map((o) => `${o.direction}:${o.code}`),
});
const dump = (b: MemoryBacking) => JSON.stringify([...b.store.entries()].sort());

async function scenario(mode: Mode) {
  const [alice, bob, other] = [await device(), await device(), await device()];
  await write(alice, 2);
  await write(other, 3);
  // alice also holds `other`'s ops (they met directly), but may only write as herself.
  expect((await alice.sync(other.endpoint())).status).toBe('complete');
  const ALICE: RelayIdentity = { token: 'a-secret', principal: 'alice', writableAs: [alice.id] };
  const BOB: RelayIdentity = { token: 'b-secret', principal: 'bob', writableAs: [bob.id] };
  const r = await relay(mode, [ALICE, BOB]);
  try {
    const out: Record<string, unknown> = {};
    // Mixed origins: alice's own origin is stored, `other`'s is refused.
    const first = await alice.sync(r.as(ALICE));
    out['alice'] = summary(first);
    out['aliceRejectedOrigin'] = first.rejectedOrigins.map((o) => o.origin === other.id);
    // bob receives alice's ops (allowed) and nothing of `other`.
    out['bob'] = summary(await bob.sync(r.as(BOB)));
    const v = (await bob.status()).vector;
    out['bobVector'] = { alice: v[alice.id] ?? 0, other: v[other.id] ?? 0 };
    // Spoofing: a device using alice's secret while claiming its own ID changes nothing.
    const before = dump(r.backing);
    const spoof = await device();
    await write(spoof, 1);
    out['spoof'] = summary(await spoof.sync(r.as(ALICE)));
    out['spoofChangedRelay'] = dump(r.backing) !== before;
    return out;
  } finally {
    await r.close();
  }
}

describe('authorization through a relay: HTTP and in-process are equivalent', () => {
  it('mixed origins, allowed progress and spoofing give identical results', async () => {
    const http = await scenario('http');
    const local = await scenario('in-process');
    expect(http).toEqual(local);
    expect(http).toEqual({
      alice: { status: 'failed', code: 'UNAUTHORIZED', rejected: ['push:UNAUTHORIZED'] },
      aliceRejectedOrigin: [true],
      bob: { status: 'complete', code: null, rejected: [] },
      bobVector: { alice: 2, other: 0 },
      spoof: { status: 'failed', code: 'UNAUTHORIZED', rejected: [] },
      spoofChangedRelay: false,
    });
  });

  it('a relay hook that denies one origin: pullers get every other origin, on both paths', async () => {
    for (const mode of ['http', 'in-process'] as const) {
      const [a, b, x] = [await device(), await device(), await device()];
      await write(a, 2);
      await write(x, 2);
      const FWD: RelayIdentity = { token: 'f-secret', principal: 'fwd', writableAs: '*' };
      let blocked = '';
      const r = await relay(
        mode,
        [FWD],
        (req) => req.direction !== 'send' || req.ops.every((o) => o.replicaId !== blocked),
      );
      try {
        expect((await a.sync(r.as(FWD))).status).toBe('complete');
        expect((await x.sync(r.as(FWD))).status).toBe('complete');
        blocked = x.id;
        const result = await b.sync(r.as(FWD));
        expect(summary(result)).toEqual({
          status: 'failed',
          code: 'UNAUTHORIZED',
          rejected: ['pull:UNAUTHORIZED'],
        });
        const v = (await b.status()).vector;
        expect(v[a.id]).toBe(2);
        expect(v[x.id]).toBeUndefined();
      } finally {
        await r.close();
      }
    }
  });

  it('nothing configured: replicas sync exactly as in 0.1.0 on both paths', async () => {
    for (const mode of ['http', 'in-process'] as const) {
      const backing = createMemoryBacking();
      const core = new RelayCore({ storage: memoryStorage({ backing }) });
      await core.open();
      const running = mode === 'http' ? await listen(createRelayServer({ core }), 0) : undefined;
      const t = () =>
        running === undefined
          ? inProcessTransport(core.endpoint())
          : httpTransport({ baseUrl: running.url });
      try {
        const [a, b] = [await device(), await device()];
        await write(a, 2);
        for (let i = 0; i < 2; i++)
          for (const d of [a, b]) expect((await d.sync(t())).status).toBe('complete');
        expect(await b.hashes()).toEqual(await a.hashes());
      } finally {
        await running?.close();
        await core.close();
      }
    }
  });
});
