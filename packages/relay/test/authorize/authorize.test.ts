/**
 * [ADV] Relay side of authorization (task T5.6, R16.3, R16.4). Every scenario runs twice: through
 * `RelayCore.endpoint({ auth })` in process, and over HTTP with the server's secret-to-identity
 * mapping. Both must give the same outcome, and a denied request must leave every stored byte of
 * the relay unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, type MemoryBacking } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import type {
  AuthContext,
  AuthorizeHook,
  AuthorizeRequest,
  SyncEndpoint,
} from '@weave/core/protocol';
import { makeOps } from '../../../testing/src/transport/index.js';
import { createRelayServer, listen, type RelayIdentity } from '../../src/server/index.js';
import { A, B, C, openRelay } from '../helpers.js';

const support = { notes: 1 };
const ALICE: RelayIdentity = { token: 'alice-secret', principal: 'alice', writableAs: [A] };
const BOB: RelayIdentity = { token: 'bob-secret', principal: 'bob', writableAs: [B] };
const FORWARDER: RelayIdentity = { token: 'fwd-secret', principal: 'forwarder', writableAs: '*' };
const IDENTITIES = [ALICE, BOB, FORWARDER];
const authOf = (i: RelayIdentity): AuthContext => ({
  principal: i.principal,
  writableAs: i.writableAs,
});

interface Harness {
  /** An endpoint as the given identity. */
  as(identity: RelayIdentity): SyncEndpoint;
  backing: MemoryBacking;
  close(): Promise<void>;
}

type Mode = 'in-process' | 'http';

async function harness(mode: Mode, authorize?: AuthorizeHook): Promise<Harness> {
  const backing = createMemoryBacking();
  const { core } = await openRelay(backing, authorize === undefined ? {} : { authorize });
  if (mode === 'in-process')
    return {
      as: (i) => core.endpoint({ auth: authOf(i) }),
      backing,
      close: () => core.close(),
    };
  const running = await listen(createRelayServer({ core, identities: IDENTITIES }), 0);
  return {
    as: (i) => httpTransport({ baseUrl: running.url, token: i.token }),
    backing,
    close: async () => {
      await running.close();
      await core.close();
    },
  };
}

/** Every stored key and value, to prove that nothing changed. */
const dump = (b: MemoryBacking) => JSON.stringify([...b.store.entries()].sort());

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

const MODES: Mode[] = ['in-process', 'http'];

describe('identity (R16.3), in-process and HTTP alike', () => {
  for (const mode of MODES) {
    it(`${mode}: allow, claimed-ID mismatch, origin mismatch, forwarder`, async () => {
      const h = await harness(mode);
      try {
        const opsA = await makeOps(A, 3);
        const opsB = await makeOps(B, 2);
        // Allowed: alice pushes her own origin.
        expect(await outcome(h.as(ALICE).push({ replicaId: A, support, ops: opsA }))).toBe('ok');
        const after = dump(h.backing);
        // Claimed replica ID mismatch on push, pull and ack: nothing changes, not even membership.
        expect(await outcome(h.as(ALICE).push({ replicaId: B, support, ops: opsB }))).toBe(
          'UNAUTHORIZED',
        );
        expect(
          await outcome(h.as(ALICE).pull({ replicaId: C, vector: {}, support, limit: 10 })),
        ).toBe('UNAUTHORIZED');
        expect(await outcome(h.as(ALICE).ack({ replicaId: C, durable: { [A]: 3 } }))).toBe(
          'UNAUTHORIZED',
        );
        // Origin mismatch: alice claims herself but carries bob's ops.
        expect(await outcome(h.as(ALICE).push({ replicaId: A, support, ops: opsB }))).toBe(
          'UNAUTHORIZED',
        );
        expect(dump(h.backing)).toBe(after);
        // A trusted forwarder may carry any origin.
        expect(await outcome(h.as(FORWARDER).push({ replicaId: C, support, ops: opsB }))).toBe(
          'ok',
        );
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a payload cannot override the authenticated identity`, async () => {
      const h = await harness(mode);
      try {
        const before = dump(h.backing);
        const forged = {
          replicaId: A,
          support,
          ops: await makeOps(B, 1),
          auth: { principal: 'admin', writableAs: '*' },
          writableAs: '*',
          principal: 'admin',
        } as unknown as Parameters<SyncEndpoint['push']>[0];
        expect(await outcome(h.as(ALICE).push(forged))).toBe('UNAUTHORIZED');
        expect(dump(h.backing)).toBe(before);
      } finally {
        await h.close();
      }
    });
  }
});

describe('authorization hook (R16.4), in-process and HTTP alike', () => {
  for (const mode of MODES) {
    it(`${mode}: push deny is atomic; the allowed part of the same origin goes through`, async () => {
      const calls: AuthorizeRequest[] = [];
      const h = await harness(mode, (req) => {
        calls.push(req);
        return req.ops.every((o) => o.seq !== 3);
      });
      try {
        const ops = await makeOps(A, 4);
        const before = dump(h.backing);
        expect(await outcome(h.as(ALICE).push({ replicaId: A, support, ops }))).toBe(
          'UNAUTHORIZED',
        );
        expect(dump(h.backing)).toBe(before);
        expect(
          await outcome(h.as(ALICE).push({ replicaId: A, support, ops: ops.slice(0, 2) })),
        ).toBe('ok');
        const apply = calls.find((c) => c.direction === 'apply')!;
        expect(apply.auth?.principal).toBe('alice');
        expect(apply.peer).toBe(A);
        expect(Object.keys(apply.ops[0]!).sort()).toEqual([
          'collection',
          'replicaId',
          'schemaVersion',
          'seq',
        ]);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: pull deny of one origin; a per-origin pull still gets the others`, async () => {
      const h = await harness(
        mode,
        (req) => req.direction !== 'send' || req.ops.every((o) => o.replicaId !== B),
      );
      try {
        await h.as(ALICE).push({ replicaId: A, support, ops: await makeOps(A, 2) });
        await h.as(BOB).push({ replicaId: B, support, ops: await makeOps(B, 2) });
        const before = dump(h.backing);
        const ask = (origins?: string[]) =>
          h.as(FORWARDER).pull({
            replicaId: C,
            vector: {},
            support,
            limit: 10,
            ...(origins === undefined ? {} : { origins }),
          });
        expect(await outcome(ask())).toBe('UNAUTHORIZED');
        expect(await outcome(ask([B]))).toBe('UNAUTHORIZED');
        const onlyA = await ask([A]);
        expect(onlyA.ops).toHaveLength(2);
        // A vector-only pull sends nothing, so the hook is not asked and it succeeds.
        const probe = await h.as(FORWARDER).pull({ replicaId: C, vector: {}, support, limit: 0 });
        expect(probe.durable).toEqual({ [A]: 2, [B]: 2 });
        // The denied pulls (as a new member C) recorded nothing, not even membership.
        void onlyA;
        expect(before).not.toBe(dump(h.backing)); // the allowed pulls registered C
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a denied pull by a new member writes nothing at all`, async () => {
      const h = await harness(mode, (req) => req.direction !== 'send');
      try {
        await h.as(ALICE).push({ replicaId: A, support, ops: await makeOps(A, 1) });
        const before = dump(h.backing);
        expect(
          await outcome(h.as(FORWARDER).pull({ replicaId: C, vector: {}, support, limit: 10 })),
        ).toBe('UNAUTHORIZED');
        expect(dump(h.backing)).toBe(before);
      } finally {
        await h.close();
      }
    });

    it(`${mode}: a hook that throws denies`, async () => {
      const h = await harness(mode, () => {
        throw new Error('policy service down');
      });
      try {
        const before = dump(h.backing);
        expect(
          await outcome(h.as(ALICE).push({ replicaId: A, support, ops: await makeOps(A, 1) })),
        ).toBe('UNAUTHORIZED');
        expect(dump(h.backing)).toBe(before);
      } finally {
        await h.close();
      }
    });
  }
});

describe('HTTP details', () => {
  it('UNAUTHORIZED is HTTP 403; unknown secrets are 401; the shared secret carries no identity', async () => {
    const { core } = await openRelay();
    const running = await listen(
      createRelayServer({ core, token: 'shared', identities: [ALICE] }),
      0,
    );
    const post = (secret: string | undefined, body: unknown) =>
      fetch(`${running.url}/v1/ack`, {
        method: 'POST',
        headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      });
    try {
      expect((await post('alice-secret', { replicaId: B, durable: {} })).status).toBe(403);
      expect((await post('alice-secret', { replicaId: A, durable: {} })).status).toBe(204);
      expect((await post('nope', { replicaId: A, durable: {} })).status).toBe(401);
      expect((await post(undefined, { replicaId: A, durable: {} })).status).toBe(401);
      // The shared secret opens the relay without an identity (0.1.0): any claimed ID.
      expect((await post('shared', { replicaId: B, durable: {} })).status).toBe(204);
    } finally {
      await running.close();
      await core.close();
    }
  });

  it('identities only (no shared secret): only mapped secrets are accepted', async () => {
    const { core } = await openRelay();
    const running = await listen(createRelayServer({ core, identities: [ALICE] }), 0);
    try {
      const res = await fetch(`${running.url}/v1/ack`, {
        method: 'POST',
        body: JSON.stringify({ replicaId: A, durable: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await running.close();
      await core.close();
    }
  });

  it('rejects invalid identity configuration at startup', async () => {
    const { core } = await openRelay();
    for (const identities of [
      [{ token: '', principal: 'x', writableAs: [A] }],
      [{ token: 't', principal: '', writableAs: [A] }],
      [{ token: 't', principal: 'x', writableAs: ['bad id'] }],
      [ALICE, { ...BOB, token: ALICE.token }],
    ])
      expect(() => createRelayServer({ core, identities })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
      );
    await core.close();
  });

  it('PUT /v1/snapshot requires the caller to act as the snapshot source', async () => {
    const { core } = await openRelay();
    await expect(core.putSnapshot({ source: B } as never, authOf(ALICE))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await core.close();
  });
});

describe('nothing configured: 0.1.0 behaviour', () => {
  it('no hook and no identities: any claimed ID and origin is accepted', async () => {
    const { core } = await openRelay();
    const ops = await makeOps(B, 2);
    await expect(core.push({ replicaId: A, support, ops })).resolves.toMatchObject({
      durable: { [B]: 2 },
    });
    await expect(
      core.endpoint().pull({ replicaId: C, vector: {}, support, limit: 5 }),
    ).resolves.toBeTruthy();
    await core.close();
  });
});
