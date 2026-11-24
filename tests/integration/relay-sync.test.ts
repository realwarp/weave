/**
 * Scenarios that span packages (design 12.3): replicas on file storage syncing through a real,
 * file-backed relay over HTTP; offline writes; relay restart; dropped connections; concurrent
 * pushes of one op ID; acknowledgements through real syncs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createReplica, type Replica } from '@weave/core';
import { keys } from '@weave/core/protocol';
import { fileStorage } from '@weave/storage/file';
import { encodePushRequest, httpTransport } from '@weave/transport/http';
import { fakeClock, fakeScheduler, seededRandom } from '../../packages/testing/src/faults/index.js';
import { FaultyEndpoint, makeOps } from '../../packages/testing/src/transport/index.js';
import { simNotesV1 } from '../../packages/testing/src/simulator/index.js';
import { startRelay } from '../../packages/relay/src/index.js';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `weave-int-${name}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let n = 0;
async function device(dir: string): Promise<Replica> {
  return createReplica({
    storage: fileStorage({ dir }),
    collections: [simNotesV1],
    random: seededRandom(`device:${dir}:${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
}

const notes = (r: Replica) => r.collection(simNotesV1);

describe('replicas syncing through a real relay over HTTP', () => {
  it('offline writes, concurrent edits and a relay restart converge to equal hashes', async () => {
    const relayDir = temp('relay');
    let relay = await startRelay({ dir: relayDir, port: 0, token: 't0k' });
    const [a, b, c] = [await device(temp('a')), await device(temp('b')), await device(temp('c'))];
    try {
      const t = () => httpTransport({ baseUrl: relay.url, token: 't0k' });
      const { recordId } = await notes(a).create(
        { title: 'shared' },
        { mutationId: a.newMutationId() },
      );
      expect((await a.sync(t())).status).toBe('complete');
      expect((await b.sync(t())).status).toBe('complete');
      // b and c edit while offline; a edits the same record concurrently.
      await notes(b).update(recordId, { title: 'from b', n: 3 }, { mutationId: b.newMutationId() });
      await notes(a).update(recordId, { title: 'from a', n: 7 }, { mutationId: a.newMutationId() });
      await notes(c).create({ title: 'c only' }, { mutationId: c.newMutationId() });
      await a.sync(t());

      // Relay restart on the same directory, on a new port.
      await relay.close();
      relay = await startRelay({ dir: relayDir, port: 0, token: 't0k' });

      for (let round = 0; round < 2; round++)
        for (const r of [a, b, c]) expect((await r.sync(t())).status).toBe('complete');
      const hashes = await Promise.all([a, b, c].map((r) => r.hashes()));
      expect(hashes[1]).toEqual(hashes[0]);
      expect(hashes[2]).toEqual(hashes[0]);
      expect((await notes(c).get(recordId))?.value.n).toBe(7); // max resolver
      // The relay acknowledged each member exactly as far as that member's own vector.
      for (const r of [a, b, c])
        expect(await relay.core.memberAck(r.id)).toEqual((await r.status()).vector);
    } finally {
      for (const r of [a, b, c]) await r.close();
      await relay.close();
    }
  });

  it('dropped requests and responses only delay convergence', async () => {
    const relay = await startRelay({ dir: temp('relay-faulty'), port: 0 });
    const [a, b] = [await device(temp('fa')), await device(temp('fb'))];
    try {
      for (let i = 0; i < 5; i++)
        await notes(a).create({ title: `a${i}`, n: i }, { mutationId: a.newMutationId() });
      for (let i = 0; i < 5; i++)
        await notes(b).create({ title: `b${i}`, n: i }, { mutationId: b.newMutationId() });
      const faulty = (seed: number) =>
        new FaultyEndpoint(httpTransport({ baseUrl: relay.url }), {
          seed,
          dropRequestRate: 0.3,
          dropResponseRate: 0.3,
          duplicateRate: 0.2,
        });
      let settled = false;
      for (let attempt = 0; attempt < 40 && !settled; attempt++) {
        await a.sync(faulty(attempt)).catch(() => undefined);
        await b.sync(faulty(attempt + 100)).catch(() => undefined);
        settled = JSON.stringify(await a.hashes()) === JSON.stringify(await b.hashes());
      }
      // A final clean round must complete, and nothing was lost or duplicated.
      expect((await a.sync(httpTransport({ baseUrl: relay.url }))).status).toBe('complete');
      expect((await b.sync(httpTransport({ baseUrl: relay.url }))).status).toBe('complete');
      expect((await a.sync(httpTransport({ baseUrl: relay.url }))).status).toBe('complete');
      expect(await a.hashes()).toEqual(await b.hashes());
      expect(await notes(a).query()).toHaveLength(10);
    } finally {
      await a.close();
      await b.close();
      await relay.close();
    }
  });
});

describe('relay concurrency over HTTP (R2.7, R4a)', () => {
  const W = 'wwwwwwwwwwwwwwwwwwwwwwwwww';
  const post = (url: string, ops: string[]) =>
    fetch(`${url}/v1/push`, {
      method: 'POST',
      body: encodePushRequest({ replicaId: W, support: { notes: 1 }, ops }),
    });

  it('identical concurrent pushes store the op once; different versions keep the first', async () => {
    const dir = temp('relay-race');
    let relay = await startRelay({ dir, port: 0 });
    try {
      const same = await makeOps(W, 1);
      const [r1, r2] = await Promise.all([post(relay.url, same), post(relay.url, same)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(await relay.core.vector()).toEqual({ [W]: 1 });

      const v2a = await makeOps(W, 1, { startSeq: 2, fields: () => ({ v: 'a' }) });
      const v2b = await makeOps(W, 1, { startSeq: 2, fields: () => ({ v: 'b' }) });
      const results = await Promise.all([post(relay.url, v2a), post(relay.url, v2b)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 400]);
      const loser = results.find((r) => r.status === 400)!;
      expect(await loser.json()).toMatchObject({ code: 'INTEGRITY_CONFLICT' });
      const winner = results[0]!.status === 200 ? v2a[0]! : v2b[0]!;
      const read = () => relay.core.storage.transaction('ro', (tx) => tx.get(keys.op(W, 2)));
      expect(await read()).toBe(winner);

      // Kill and restart: the stored op is unchanged.
      await relay.close();
      relay = await startRelay({ dir, port: 0 });
      expect(await read()).toBe(winner);
      expect(await relay.core.memberAck(W)).toEqual({ [W]: 2 });
    } finally {
      await relay.close();
    }
  });
});
