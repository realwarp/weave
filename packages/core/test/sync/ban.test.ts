/**
 * [ADV] Peer ban (task T5.7, R10.5): a peer that repeatedly sends invalid data is refused for a
 * configurable period measured by the monotonic scheduler (fake scheduler here); valid peers are
 * unaffected; errors that are not invalid data never count; the ban is off by default.
 */
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import {
  fakeClock,
  fakeScheduler,
  seededRandom,
  type FakeClock,
  type FakeScheduler,
} from '../../../testing/src/faults/index.js';
import type { BanOptions, Replica } from '../../src/contracts/replica.js';
import type { AuthorizeHook, SyncEndpoint } from '../../src/contracts/sync.js';
import { createReplica } from '../../src/engine/replica.js';
import { defineCollection, f } from '../../src/schema/index.js';
import { BanBook, DEFAULT_BAN, isInvalidData } from '../../src/sync/ban.js';
import { WeaveError } from '../../src/contracts/errors.js';

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });
const BAN: BanOptions = { enabled: true, threshold: 3, windowMs: 1_000, banMs: 10_000 };

let seed = 0;
async function open(
  options: { ban?: BanOptions; authorize?: AuthorizeHook } = {},
): Promise<{ r: Replica; scheduler: FakeScheduler; clock: FakeClock }> {
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const r = await createReplica({
    storage: memoryStorage(),
    collections: [notes],
    random: seededRandom(`ban-${seed++}`),
    clock,
    scheduler,
    ...(options.ban === undefined ? {} : { ban: options.ban }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
  });
  return { r, scheduler, clock };
}
let m = 0;
const write = async (r: Replica, n: number) => {
  for (let i = 0; i < n; i++)
    await r.collection(notes).create({ title: `t${i}` }, { mutationId: `bn-${m++}` });
};
/** All op lines of `r`, as a peer would receive them. */
const linesOf = async (r: Replica) =>
  (
    await r
      .endpoint()
      .pull({ replicaId: 'z'.repeat(26), vector: {}, support: { notes: 1 }, limit: 50 })
  ).ops;
/** A line whose content no longer matches its hash: invalid data (INTEGRITY_CONFLICT). */
const tamper = (line: string) => line.replace('"title":"t', '"title":"X');
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};
const fingerprint = async (r: Replica) => {
  const s = await r.status();
  return { hashes: await r.hashes(), vector: s.vector, peers: s.peers, buffer: s.pendingBuffer };
};

describe('BanBook (pure, monotonic time)', () => {
  it('threshold strikes within the window ban; the ban ends after banMs', () => {
    let now = 0;
    const book = new BanBook(BAN, () => now);
    expect(book.strike('p')).toBe(false);
    now = 400;
    expect(book.strike('p')).toBe(false);
    now = 900;
    expect(book.strike('p')).toBe(true);
    expect(book.remainingMs('p')).toBe(10_000);
    expect(() => book.assertNotBanned('p')).toThrow(
      expect.objectContaining({ code: 'PEER_BANNED' }) as Error,
    );
    expect(book.status()).toEqual([{ peer: 'p', remainingMs: 10_000 }]);
    expect(book.strike('p')).toBe(false); // strikes while banned do not extend the ban
    now = 900 + 9_999;
    expect(book.remainingMs('p')).toBe(1);
    now = 900 + 10_000;
    expect(book.remainingMs('p')).toBe(0);
    expect(book.status()).toEqual([]);
    expect(() => book.assertNotBanned('p')).not.toThrow();
    // A fresh start: one strike does not ban again.
    expect(book.strike('p')).toBe(false);
  });

  it('strikes older than the window do not count; peers are independent', () => {
    let now = 0;
    const book = new BanBook(BAN, () => now);
    book.strike('p');
    now = 1_000;
    book.strike('p'); // the first strike has left the window
    now = 1_500;
    expect(book.strike('p')).toBe(false);
    expect(book.strike('q')).toBe(false);
    expect(book.strike('p')).toBe(true);
    expect(book.remainingMs('q')).toBe(0);
  });

  it('defaults and option validation', () => {
    expect(DEFAULT_BAN).toEqual({ threshold: 3, windowMs: 60_000, banMs: 300_000 });
    for (const bad of [{ threshold: 0 }, { windowMs: -1 }, { banMs: 1.5 }])
      expect(() => new BanBook({ enabled: true, ...bad }, () => 0)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
      );
  });

  it('only invalid-data codes are strikes', () => {
    for (const c of [
      'VALIDATION_FAILED',
      'UNSUPPORTED_VALUE',
      'INTEGRITY_CONFLICT',
      'MIGRATION_FAILED',
    ] as const)
      expect(isInvalidData(new WeaveError(c, 'x'))).toBe(true);
    for (const c of [
      'UNAUTHORIZED',
      'SCHEMA_TOO_NEW',
      'NOT_SUPPORTED',
      'PEER_REMOVED',
      'TRANSPORT_ERROR',
      'STORAGE_CONFLICT',
    ] as const)
      expect(isInvalidData(new WeaveError(c, 'x'))).toBe(false);
    expect(isInvalidData(new Error('x'))).toBe(false);
  });

  it('createReplica rejects invalid ban options before opening storage', async () => {
    await expect(
      createReplica({
        storage: memoryStorage(),
        collections: [notes],
        ban: { enabled: true, threshold: 0 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the endpoint bans a peer that pushes invalid data (R10.5)', () => {
  it('three invalid pushes ban the sender; nothing it sends is accepted until the ban ends', async () => {
    const { r: receiver, scheduler, clock } = await open({ ban: BAN });
    const { r: bad } = await open();
    await write(bad, 2);
    const lines = await linesOf(bad);
    const ep = receiver.endpoint();
    const push = (ops: readonly string[]) =>
      ep.push({ replicaId: bad.id, support: { notes: 1 }, ops });
    for (let i = 0; i < 3; i++)
      expect(await code(push([tamper(lines[0]!)]))).toBe('INTEGRITY_CONFLICT');
    expect((await receiver.status()).bans).toEqual([{ peer: bad.id, remainingMs: 10_000 }]);
    // Even valid data from it is refused, with no change at all.
    const before = await fingerprint(receiver);
    expect(await code(push(lines))).toBe('PEER_BANNED');
    expect(await code(ep.ack({ replicaId: bad.id, durable: {} }))).toBe('PEER_BANNED');
    expect(await fingerprint(receiver)).toEqual(before);
    // Wall-clock time does not lift the ban; only monotonic time does.
    clock.advance(10 * 24 * 3600 * 1000);
    expect(await code(push(lines))).toBe('PEER_BANNED');
    scheduler.advance(9_999);
    expect(await code(push(lines))).toBe('PEER_BANNED');
    scheduler.advance(1);
    expect(await code(push(lines))).toBe('ok');
    expect((await receiver.status()).vector[bad.id]).toBe(2);
    expect((await receiver.status()).bans).toBeUndefined();
  });

  it('a banned peer is still served pulls (a ban stops accepting, not sending)', async () => {
    const { r: receiver } = await open({ ban: BAN });
    await write(receiver, 1);
    const { r: bad } = await open();
    await write(bad, 1);
    const line = (await linesOf(bad))[0]!;
    for (let i = 0; i < 3; i++)
      await code(
        receiver.endpoint().push({ replicaId: bad.id, support: { notes: 1 }, ops: [tamper(line)] }),
      );
    const res = await receiver
      .endpoint()
      .pull({ replicaId: bad.id, vector: {}, support: { notes: 1 }, limit: 10 });
    expect(res.ops).toHaveLength(1);
  });

  it('valid peers are unaffected while another peer is banned', async () => {
    const { r: receiver } = await open({ ban: BAN });
    const { r: bad } = await open();
    const { r: good } = await open();
    await write(bad, 1);
    await write(good, 2);
    const line = (await linesOf(bad))[0]!;
    for (let i = 0; i < 3; i++)
      await code(
        receiver.endpoint().push({ replicaId: bad.id, support: { notes: 1 }, ops: [tamper(line)] }),
      );
    expect((await good.sync(receiver.endpoint())).status).toBe('complete');
    expect((await receiver.status()).vector[good.id]).toBe(2);
    expect((await receiver.status()).bans?.map((b) => b.peer)).toEqual([bad.id]);
  });

  it('errors that are not invalid data never ban (authorization denials)', async () => {
    const { r: receiver } = await open({ ban: BAN, authorize: () => false });
    const { r: peer } = await open();
    await write(peer, 1);
    const lines = await linesOf(peer);
    for (let i = 0; i < 6; i++)
      expect(
        await code(
          receiver.endpoint().push({ replicaId: peer.id, support: { notes: 1 }, ops: lines }),
        ),
      ).toBe('UNAUTHORIZED');
    expect((await receiver.status()).bans).toBeUndefined();
  });

  it('off by default: repeated invalid pushes never ban', async () => {
    const { r: receiver } = await open();
    const { r: bad } = await open();
    await write(bad, 1);
    const lines = await linesOf(bad);
    for (let i = 0; i < 6; i++)
      await code(
        receiver
          .endpoint()
          .push({ replicaId: bad.id, support: { notes: 1 }, ops: [tamper(lines[0]!)] }),
      );
    expect(
      await code(
        receiver.endpoint().push({ replicaId: bad.id, support: { notes: 1 }, ops: lines }),
      ),
    ).toBe('ok');
    expect((await receiver.status()).bans).toBeUndefined();
  });
});

describe('the sync client bans an endpoint that serves invalid data (R10.5)', () => {
  /** `source`'s endpoint, but serving tampered op lines while `evil.on` is true. */
  function corrupting(source: Replica, evil: { on: boolean }): SyncEndpoint {
    const real = source.endpoint();
    return {
      ...real,
      pull: async (req) => {
        const res = await real.pull(req);
        return evil.on ? { ...res, ops: res.ops.map(tamper) } : res;
      },
    };
  }

  it('three syncs with invalid data ban the endpoint; then nothing it serves is applied', async () => {
    const { r: client, scheduler } = await open({ ban: BAN });
    const { r: source } = await open();
    await write(source, 2);
    const evil = { on: true };
    for (let i = 0; i < 3; i++) {
      const res = await client.sync(corrupting(source, evil));
      expect(res.status).toBe('failed');
      expect(res.rejectedOrigins.map((o) => `${o.direction}:${o.code}`)).toEqual([
        'pull:INTEGRITY_CONFLICT',
      ]);
    }
    expect((await client.status()).bans).toEqual([{ peer: source.id, remainingMs: 10_000 }]);
    // The endpoint is honest now, but banned: the sync applies nothing.
    evil.on = false;
    const before = await fingerprint(client);
    const banned = await client.sync(corrupting(source, evil));
    expect(banned.status === 'failed' && banned.code).toBe('PEER_BANNED');
    expect((await fingerprint(client)).hashes).toEqual(before.hashes);
    expect((await client.status()).vector[source.id]).toBeUndefined();
    // Another endpoint syncs fine meanwhile.
    const { r: other } = await open();
    await write(other, 1);
    expect((await client.sync(other.endpoint())).status).toBe('complete');
    // After the ban, the honest endpoint syncs completely.
    scheduler.advance(10_000);
    expect((await client.sync(corrupting(source, evil))).status).toBe('complete');
    expect((await client.status()).vector[source.id]).toBe(2);
  });

  it('a sync rejected only for schema or authorization reasons is not a strike', async () => {
    const { r: client } = await open({
      ban: { ...BAN, threshold: 1 },
      authorize: (req) => req.direction !== 'apply',
    });
    const { r: source } = await open();
    await write(source, 1);
    const res = await client.sync(source.endpoint());
    expect(res.rejectedOrigins.map((o) => o.code)).toEqual(['UNAUTHORIZED']);
    expect((await client.status()).bans).toBeUndefined();
  });
});
