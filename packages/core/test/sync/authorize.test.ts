/**
 * [ADV] Authorization hook and authenticated identity, replica side (task T5.6, R16.3, R16.4):
 * allow, deny and identity mismatch on the endpoint and in the sync client; atomic rejection;
 * per-origin isolation; identity that a request payload cannot override; 0.1.0 behaviour when
 * nothing is configured; direct and in-process endpoints behave the same.
 */
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import { inProcessTransport } from '../../../transport/src/in-process/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import type { Replica } from '../../src/contracts/replica.js';
import type {
  AuthContext,
  AuthorizeHook,
  AuthorizeRequest,
  SyncEndpoint,
} from '../../src/contracts/sync.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { assertIdentity, mayActAs, runAuthorize } from '../../src/sync/authorize.js';

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });

let seed = 0;
const open = (authorize?: AuthorizeHook): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [notes],
    random: seededRandom(`auth-${seed++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
    ...(authorize === undefined ? {} : { authorize }),
  });
const col = (r: Replica) => r.collection(notes);
let m = 0;
const mid = () => `au-${m++}`;
const write = async (r: Replica, n = 1) => {
  for (let i = 0; i < n; i++) await col(r).create({ title: `${r.id}-${i}` }, { mutationId: mid() });
};
const code = (e: unknown) => (e as { code?: string }).code;

/** Everything observable about a replica's data, to prove that nothing changed. */
async function fingerprint(r: Replica) {
  const s = await r.status();
  return { hashes: await r.hashes(), vector: s.vector, peers: s.peers, buffer: s.pendingBuffer };
}

/** Three replicas: `a` also holds every op of `c`. */
async function trio(hooks: { a?: AuthorizeHook; b?: AuthorizeHook } = {}) {
  const a = await open(hooks.a);
  const b = await open(hooks.b);
  const c = await open();
  await write(a, 2);
  await write(c, 2);
  expect((await a.sync(c.endpoint())).status).toBe('complete');
  return { a, b, c };
}

describe('helpers (R16.3, R16.4)', () => {
  it('mayActAs and assertIdentity', () => {
    const bob: AuthContext = { principal: 'bob', writableAs: ['b'.repeat(26)] };
    expect(mayActAs(undefined, 'x')).toBe(true);
    expect(mayActAs(bob, 'b'.repeat(26))).toBe(true);
    expect(mayActAs(bob, 'a'.repeat(26))).toBe(false);
    expect(mayActAs({ principal: 'relay', writableAs: '*' }, 'a'.repeat(26))).toBe(true);
    expect(() => assertIdentity(bob, 'b'.repeat(26), ['a'.repeat(26)])).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }) as Error,
    );
    expect(() => assertIdentity(undefined, 'anything', ['x'])).not.toThrow();
  });

  it('runAuthorize fails closed on anything but true', async () => {
    const req: AuthorizeRequest = {
      direction: 'apply',
      peer: 'p',
      ops: [{ replicaId: 'r', seq: 1, collection: 'notes', schemaVersion: 1 }],
    };
    await expect(runAuthorize(() => true, req)).resolves.toBeUndefined();
    await expect(runAuthorize(undefined, req)).resolves.toBeUndefined();
    await expect(runAuthorize(() => false, { ...req, ops: [] })).resolves.toBeUndefined();
    for (const hook of [
      () => false,
      () => 'yes' as unknown as boolean,
      () => Promise.resolve(false),
      () => Promise.reject(new Error('down')),
      () => {
        throw new Error('boom');
      },
    ])
      await expect(runAuthorize(hook, req)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('nothing configured: 0.1.0 behaviour (R16.4 optional)', () => {
  it('sync completes and the hook-free endpoint accepts any claimed replica ID', async () => {
    const { a, b } = await trio();
    expect((await b.sync(a.endpoint())).status).toBe('complete');
    expect(await b.hashes()).toEqual(await a.hashes());
  });
});

describe('authenticated identity on the endpoint (R16.3)', () => {
  it('a caller that claims a replica ID it may not act as is refused with no change', async () => {
    const { a, b } = await trio();
    const before = await fingerprint(b);
    const ep = b.endpoint({ auth: { principal: 'mallory', writableAs: ['z'.repeat(26)] } });
    const result = await a.sync(ep);
    expect(result.status === 'failed' && result.code).toBe('UNAUTHORIZED');
    expect(await fingerprint(b)).toEqual(before); // no ops, no acks, no peer entry
    await expect(
      ep.ack({ replicaId: a.id, durable: (await a.status()).vector }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await fingerprint(b)).toEqual(before);
  });

  it('a direct pull that claims another replica ID is refused (no reading as someone else)', async () => {
    const { a, b } = await trio();
    const ep = a.endpoint({ auth: { principal: 'bob', writableAs: [b.id] } });
    await expect(
      ep.pull({ replicaId: 'z'.repeat(26), vector: {}, support: { notes: 1 }, limit: 10 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // Its own ID is fine, including a vector-only pull.
    const own = await ep.pull({ replicaId: b.id, vector: {}, support: { notes: 1 }, limit: 10 });
    expect(own.ops.length).toBeGreaterThan(0);
  });

  it('a payload cannot override the bound identity', async () => {
    const { a, b } = await trio();
    const before = await fingerprint(b);
    const ep = b.endpoint({ auth: { principal: 'mallory', writableAs: ['z'.repeat(26)] } });
    const lines = (
      await a.endpoint().pull({ replicaId: b.id, vector: {}, support: { notes: 1 }, limit: 10 })
    ).ops;
    const forged = {
      replicaId: a.id,
      support: { notes: 1 },
      ops: lines,
      auth: { principal: 'admin', writableAs: '*' },
    } as unknown as Parameters<SyncEndpoint['push']>[0];
    await expect(ep.push(forged)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await fingerprint(b)).toEqual(before);
  });

  it('pushed ops of an origin the caller may not write are rejected; its own origin syncs', async () => {
    const { a, b, c } = await trio();
    const ep = b.endpoint({ auth: { principal: 'alice', writableAs: [a.id] } });
    const result = await a.sync(ep);
    expect(result.status).toBe('failed');
    expect(result.rejectedOrigins).toEqual([
      { origin: c.id, code: 'UNAUTHORIZED', direction: 'push' },
    ]);
    const vector = (await b.status()).vector;
    expect(vector[a.id]).toBe(2);
    expect(vector[c.id]).toBeUndefined();
  });

  it("writableAs '*' (a trusted forwarder) completes", async () => {
    const { a, b } = await trio();
    const ep = b.endpoint({ auth: { principal: 'relay', writableAs: '*' } });
    expect((await a.sync(ep)).status).toBe('complete');
    expect((await b.hashes()).ops).toBe((await a.hashes()).ops);
  });
});

describe('the authorization hook (R16.4)', () => {
  it('receiver apply-deny of one origin: the other origin still syncs, nothing partial', async () => {
    const deny = { id: '' };
    const seen: AuthorizeRequest[] = [];
    const {
      a,
      b,
      c: cc,
    } = await trio({
      b: (req) => {
        seen.push(req);
        return req.direction !== 'apply' || req.ops.every((o) => o.replicaId !== deny.id);
      },
    });
    deny.id = cc.id;
    const result = await b.sync(a.endpoint());
    expect(result.rejectedOrigins).toEqual([
      { origin: cc.id, code: 'UNAUTHORIZED', direction: 'pull' },
    ]);
    const vector = (await b.status()).vector;
    expect(vector[a.id]).toBe(2);
    expect(vector[cc.id]).toBeUndefined();
    // The hook sees envelope fields only, and the peer it talks to.
    const req = seen.find((r) => r.direction === 'apply')!;
    expect(req.peer).toBe(a.id);
    expect(Object.keys(req.ops[0]!).sort()).toEqual([
      'collection',
      'replicaId',
      'schemaVersion',
      'seq',
    ]);
  });

  it('endpoint send-deny of one origin: the puller gets the rest (direct and in-process)', async () => {
    for (const wrap of [(e: SyncEndpoint) => e, inProcessTransport]) {
      let deny = '';
      const { a, b, c } = await trio({
        a: (req) => req.direction !== 'send' || req.ops.every((o) => o.replicaId !== deny),
      });
      deny = c.id;
      const result = await b.sync(wrap(a.endpoint()));
      expect(result.rejectedOrigins).toEqual([
        { origin: c.id, code: 'UNAUTHORIZED', direction: 'pull' },
      ]);
      const vector = (await b.status()).vector;
      expect(vector[a.id]).toBe(2);
      expect(vector[c.id]).toBeUndefined();
    }
  });

  it('local send-deny: nothing leaves, the sync fails with UNAUTHORIZED', async () => {
    let denySend = false;
    const { a, b } = await trio({ a: (req) => !(denySend && req.direction === 'send') });
    denySend = true;
    const before = await fingerprint(b);
    const result = await a.sync(b.endpoint());
    expect(result.status === 'failed' && result.code).toBe('UNAUTHORIZED');
    expect(result.rejectedOrigins.map((r) => r.direction)).toEqual(['push', 'push']);
    expect((await b.hashes()).ops).toBe(before.hashes.ops);
  });

  it('a batch with one denied op is rejected whole (atomic)', async () => {
    const b = await open((req) => req.ops.every((o) => o.seq !== 2));
    const a = await open();
    await write(a, 3);
    const lines = (
      await a.endpoint().pull({ replicaId: b.id, vector: {}, support: { notes: 1 }, limit: 10 })
    ).ops;
    const before = await fingerprint(b);
    await expect(
      b.endpoint().push({ replicaId: a.id, support: { notes: 1 }, ops: lines }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await fingerprint(b)).toEqual(before);
    // The first op alone is allowed.
    await b.endpoint().push({ replicaId: a.id, support: { notes: 1 }, ops: [lines[0]!] });
    expect((await b.status()).vector[a.id]).toBe(1);
  });

  it('a hook that throws denies, and local writes never call it', async () => {
    let calls = 0;
    const b = await open(() => {
      calls++;
      throw new Error('policy service down');
    });
    await write(b, 1); // local writes are not sync: no hook
    expect(calls).toBe(0);
    const a = await open();
    await write(a, 1);
    const result = await b.sync(a.endpoint());
    expect(result.status === 'failed' && result.code).toBe('UNAUTHORIZED');
    expect(code(result.status === 'failed' ? result.error : undefined)).toBe('UNAUTHORIZED');
    expect((await b.status()).vector[a.id]).toBeUndefined();
  });
});
