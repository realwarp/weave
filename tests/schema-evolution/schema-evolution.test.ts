/**
 * Schema evolution through a real relay (task T2.4, R8.6, R14.5, R15.12). Version 2 of `sites`
 * splits the v1 string `location` ("lat,lon") into two numbers with a migration. Stored ops are
 * never rewritten; every replica upgrades them on read.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { defineCollection, f, type Replica } from '@weave/core';
import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import { httpTransport } from '@weave/transport/http';
import { cleanTemps, device, startRelayProcess, tempDir } from '../relay/helpers.js';

afterAll(cleanTemps);

const sitesV1 = defineCollection({
  name: 'sites',
  version: 1,
  fields: { name: f.string({ required: true }), location: f.string() },
});

const sitesV2 = defineCollection({
  name: 'sites',
  version: 2,
  fields: { name: f.string({ required: true }), lat: f.number(), lon: f.number() },
  migrations: {
    1: ({ fields }) => {
      const { location, ...rest } = fields;
      if (typeof location !== 'string') return { ...rest };
      const [lat, lon] = location.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon)
        ? { ...rest, lat: lat!, lon: lon! }
        : { ...rest };
    },
  },
});

interface Device {
  name: string;
  backing: MemoryBacking;
  replica: Replica;
}

async function open(
  name: string,
  version: 1 | 2,
  backing = createMemoryBacking(),
): Promise<Device> {
  const replica = await device(
    name,
    [version === 1 ? sitesV1 : sitesV2],
    memoryStorage({ backing }),
  );
  return { name, backing, replica };
}

async function upgrade(d: Device): Promise<Device> {
  await d.replica.close();
  return open(`${d.name}-v2`, 2, d.backing);
}

describe('schema evolution v1 -> v2 through the relay', () => {
  it(
    'upgraded replicas derive equal state; a v1 replica gets the readable prefix, then converges',
    { timeout: 60_000 },
    async () => {
      const relay = await startRelayProcess(tempDir('schema-evolution'));
      const t = () => httpTransport({ baseUrl: relay.url });
      try {
        // Three v1 devices write and converge.
        let a = await open('a', 1);
        let b = await open('b', 1);
        let c = await open('c', 1);
        const { recordId: north } = await a.replica
          .collection(sitesV1)
          .create({ name: 'North', location: '52.5,13.4' }, { mutationId: 'a1' });
        await b.replica
          .collection(sitesV1)
          .create({ name: 'South', location: 'unknown' }, { mutationId: 'b1' });
        for (let i = 0; i < 2; i++)
          for (const d of [a, b, c]) expect((await d.replica.sync(t())).status).toBe('complete');

        // a and b upgrade. Their state is derived from the same v1 ops through the migration.
        a = await upgrade(a);
        b = await upgrade(b);
        expect((await a.replica.hashes()).state).toBe((await b.replica.hashes()).state);
        expect((await a.replica.collection(sitesV2).get(north))?.value).toEqual({
          name: 'North',
          lat: 52.5,
          lon: 13.4,
        });

        // a writes with v2; b converges with it through the relay.
        await a.replica.collection(sitesV2).update(north, { lat: 52.52 }, { mutationId: 'a2' });
        expect((await a.replica.sync(t())).status).toBe('complete');
        expect((await b.replica.sync(t())).status).toBe('complete');
        expect(await b.replica.hashes()).toEqual(await a.replica.hashes());

        // c is still v1: it receives nothing it cannot read and says so.
        const partial = await c.replica.sync(t());
        expect(partial).toMatchObject({ status: 'partial', code: 'PEER_SCHEMA_OLDER' });
        expect(partial.blocked[0]).toMatchObject({
          origin: a.replica.id,
          requiredVersion: 2,
          direction: 'pull',
        });
        expect((await c.replica.status()).vector[a.replica.id]).toBe(1);
        expect((await c.replica.collection(sitesV1).get(north))?.value.location).toBe('52.5,13.4');

        // c writes offline with v1, then upgrades; everybody converges.
        await c.replica
          .collection(sitesV1)
          .create({ name: 'East', location: '1,2' }, { mutationId: 'c1' });
        c = await upgrade(c);
        for (let i = 0; i < 2; i++)
          for (const d of [a, b, c]) expect((await d.replica.sync(t())).status).toBe('complete');
        const hashes = await Promise.all([a, b, c].map((d) => d.replica.hashes()));
        expect(hashes[1]).toEqual(hashes[0]);
        expect(hashes[2]).toEqual(hashes[0]);
        const sites = await a.replica.collection(sitesV2).query({ orderBy: 'name' });
        expect(sites.map((s) => s.value)).toEqual([
          { name: 'East', lat: 1, lon: 2 },
          { name: 'North', lat: 52.52, lon: 13.4 },
          { name: 'South' },
        ]);
        // Op history keeps the original v1 fields of v1 ops.
        const history = await c.replica.collection(sitesV2).history(north);
        expect(history.map((h) => h.schemaVersion)).toEqual([1, 2]);
        expect(history[0]!.fields).toEqual({ name: 'North', location: '52.5,13.4' });
        for (const d of [a, b, c]) await d.replica.close();
      } finally {
        await relay.stop();
      }
    },
  );
});
