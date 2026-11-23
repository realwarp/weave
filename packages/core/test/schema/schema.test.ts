import { describe, expect, expectTypeOf, it } from 'vitest';
import { WeaveError } from '../../src/contracts/errors.js';
import type { InferRecord } from '../../src/contracts/schema.js';
import { defineCollection, f, migrateFields, validateLocalWrite } from '../../src/schema/index.js';
import { makeReplica } from '../engine/helpers.js';
import { createMemoryBacking } from '../../../storage/src/memory/index.js';

const v1 = defineCollection({
  name: 'inspections',
  version: 1,
  fields: { title: f.string({ required: true }), location: f.string() },
});

const split = ({ fields }: { fields: Readonly<Record<string, unknown>> }) => {
  const { location, ...rest } = fields as Record<string, string>;
  const [site, zone] = (location ?? '').split(' / ');
  return { ...rest, site: site ?? '', zone: zone ?? '' };
};

const v2 = defineCollection({
  name: 'inspections',
  version: 2,
  fields: { title: f.string({ required: true }), site: f.string(), zone: f.string() },
  migrations: { 1: split },
});

describe('schema definition (R8.1, R11.1)', () => {
  it('infers record types', () => {
    expectTypeOf<InferRecord<typeof v2>>().toEqualTypeOf<{
      title: string;
      site?: string;
      zone?: string;
    }>();
    const _r = defineCollection({
      name: 'r',
      version: 1,
      fields: { s: f.rank(['a', 'b'] as const, { required: true }), t: f.set(f.number()) },
    });
    expectTypeOf<InferRecord<typeof _r>>().toEqualTypeOf<{ s: 'a' | 'b'; t?: number[] }>();
  });

  it('rejects bad definitions', () => {
    expect(() => defineCollection({ name: '9x', version: 1, fields: {} })).toThrow(WeaveError);
    expect(() => defineCollection({ name: 'x', version: 0, fields: {} })).toThrow(WeaveError);
    expect(() => defineCollection({ name: 'x', version: 2, fields: {} })).toThrow(
      /missing migration/,
    );
    expect(() => f.rank(['a', 'a'])).toThrow(WeaveError);
    expect(() => f.rank([])).toThrow(WeaveError);
    expect(() => f.rank(['a', 1] as never)).toThrow(WeaveError);
  });

  it('validates local writes (R8.2)', () => {
    expect(() => validateLocalWrite(v2, 'create', { site: 'x' })).toThrow(/required/);
    expect(() => validateLocalWrite(v2, 'create', { title: 't', bogus: 1 })).toThrow(
      /Unknown field/,
    );
    expect(() => validateLocalWrite(v2, 'update', {})).toThrow(/at least one/);
    expect(validateLocalWrite(v2, 'update', { zone: 'z' })).toEqual({ zone: 'z' });
  });
});

describe('migrations (R8.3 to R8.5, R15.12)', () => {
  it('upgrades op fields through the chain', () => {
    expect(
      migrateFields(v2, {
        fields: { title: 't', location: 'North / A3' },
        recordId: 'r',
        fromVersion: 1,
      }),
    ).toEqual({
      title: 't',
      site: 'North',
      zone: 'A3',
    });
  });

  it('repeatability: the same input gives the same output, also on a fresh definition', () => {
    const input = { fields: { title: 't', location: 'S / B' }, recordId: 'r', fromVersion: 1 };
    const fresh = defineCollection({ ...v2, migrations: { 1: split } });
    expect(migrateFields(v2, input)).toEqual(migrateFields(v2, input));
    expect(migrateFields(fresh, input)).toEqual(migrateFields(v2, input));
  });

  it('chain v1 -> v2 -> v3 does not depend on intermediate results', () => {
    const v3 = defineCollection({
      name: 'inspections',
      version: 3,
      fields: {
        title: f.string({ required: true }),
        site: f.string(),
        zone: f.string(),
        level: f.number(),
      },
      migrations: { 1: split, 2: ({ fields }) => ({ ...fields, level: 0 }) },
    });
    const fromV1 = migrateFields(v3, {
      fields: { title: 't', location: 'N / Z' },
      recordId: 'r',
      fromVersion: 1,
    });
    const viaV2 = migrateFields(v3, {
      fields: migrateFields(v2, {
        fields: { title: 't', location: 'N / Z' },
        recordId: 'r',
        fromVersion: 1,
      }),
      recordId: 'r',
      fromVersion: 2,
    });
    expect(fromV1).toEqual(viaV2);
  });

  it('the input is deep-frozen: a migration that mutates it fails with MIGRATION_FAILED', () => {
    const mutating = defineCollection({
      name: 'inspections',
      version: 2,
      fields: { title: f.string({ required: true }) },
      migrations: {
        1: ({ fields }) => {
          (fields as Record<string, unknown>)['title'] = 'changed';
          return { ...fields };
        },
      },
    });
    expect(() =>
      migrateFields(mutating, { fields: { title: 't' }, recordId: 'r', fromVersion: 1 }),
    ).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
  });

  it('upgrade on open: v1 data becomes v2 state, two replicas derive equal hashes (R8.6)', async () => {
    const backings = [createMemoryBacking(), createMemoryBacking()];
    const ids: string[] = [];
    for (const [i, backing] of backings.entries()) {
      const t = await makeReplica({ backing, collections: [v1], seed: `writer-${i}` });
      if (i === 0)
        ids.push(
          (
            await t.replica
              .collection(v1)
              .create({ title: 't', location: 'North / A3' }, { mutationId: 'c1' })
          ).recordId,
        );
      await t.replica.close();
    }
    const a = await makeReplica({ backing: backings[0]!, collections: [v2] });
    expect((await a.replica.collection(v2).get(ids[0]!))?.value).toEqual({
      title: 't',
      site: 'North',
      zone: 'A3',
    });
    const b = await makeReplica({ backing: backings[1]!, collections: [v2] });
    expect((await b.replica.sync(a.replica.endpoint())).status).toBe('complete');
    expect(await b.replica.hashes()).toEqual(await a.replica.hashes());
    // new writes use v2
    await b.replica.collection(v2).update(ids[0]!, { zone: 'B1' }, { mutationId: 'u1' });
    const hist = await b.replica.collection(v2).history(ids[0]!);
    expect(hist.map((h) => h.schemaVersion)).toEqual([1, 2]);
  });

  it('a failing migration rolls back: the replica stays at the old version (R8.4)', async () => {
    const backing = createMemoryBacking();
    const t = await makeReplica({ backing, collections: [v1] });
    await t.replica.collection(v1).create({ title: 't' }, { mutationId: 'c' });
    const before = await t.replica.hashes();
    await t.replica.close();
    const broken = defineCollection({
      name: 'inspections',
      version: 2,
      fields: { title: f.string({ required: true }) },
      migrations: {
        1: () => {
          throw new Error('bug');
        },
      },
    });
    await expect(makeReplica({ backing, collections: [broken] })).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
    });
    const again = await makeReplica({ backing, collections: [v1] });
    expect(await again.replica.hashes()).toEqual(before);
  });

  it('opening with an older schema than the stored one is SCHEMA_DOWNGRADE (R8.8)', async () => {
    const backing = createMemoryBacking();
    const t = await makeReplica({ backing, collections: [v2] });
    await t.replica.close();
    await expect(makeReplica({ backing, collections: [v1] })).rejects.toMatchObject({
      code: 'SCHEMA_DOWNGRADE',
    });
  });
});
