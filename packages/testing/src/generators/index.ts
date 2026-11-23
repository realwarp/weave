/**
 * fast-check arbitraries for WEAVE tests (design 12.2). Every generated value respects the real
 * constraints: replica IDs match the 26-character base32 pattern, JSON values are D7-supported
 * (safe integers, no lone surrogates, bounded depth), and frontier entries are internally
 * consistent (`opId` matches `replicaId` and `seq`).
 */
import fc from 'fast-check';
import type { FrontierEntry, JsonValue, OpPayload, ReplicaId, VersionVector } from '@weave/core';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'.split('');

export function arbReplicaId(): fc.Arbitrary<ReplicaId> {
  return fc
    .array(fc.constantFrom(...BASE32), { minLength: 26, maxLength: 26 })
    .map((chars) => chars.join(''));
}

/** A small pool of distinct replica IDs, useful for vectors and frontiers. */
export function arbReplicaPool(size = 4): fc.Arbitrary<ReplicaId[]> {
  return fc.uniqueArray(arbReplicaId(), { minLength: size, maxLength: size });
}

export function arbVersionVector(replicas?: readonly ReplicaId[]): fc.Arbitrary<VersionVector> {
  const id = replicas === undefined ? arbReplicaId() : fc.constantFrom(...replicas);
  return fc
    .array(fc.tuple(id, fc.integer({ min: 1, max: 1000 })), { maxLength: 6 })
    .map((entries) => {
      const v: Record<string, number> = {};
      for (const [r, seq] of entries) v[r] = Math.max(v[r] ?? 0, seq);
      return v;
    });
}

/** Strings without lone surrogates (full Unicode, including astral characters). */
export function arbSafeString(maxLength = 12): fc.Arbitrary<string> {
  return fc.string({ unit: 'grapheme', maxLength });
}

/** D7-supported JSON values. */
export function arbJsonValue(maxDepth = 3): fc.Arbitrary<JsonValue> {
  const leaf: fc.Arbitrary<JsonValue> = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n) || Number.isSafeInteger(n)),
    arbSafeString(),
  );
  const build = (depth: number): fc.Arbitrary<JsonValue> =>
    depth <= 0
      ? leaf
      : fc.oneof(
          { weight: 3, arbitrary: leaf },
          { weight: 1, arbitrary: fc.array(build(depth - 1), { maxLength: 4 }) },
          {
            weight: 1,
            arbitrary: fc.dictionary(arbSafeString(6), build(depth - 1), { maxKeys: 4 }),
          },
        );
  return build(maxDepth);
}

/** A record-fields object: field name to supported value. */
export function arbFields(): fc.Arbitrary<Record<string, JsonValue>> {
  return fc.dictionary(
    arbSafeString(8).filter((k) => k.length > 0 && !k.includes('\u0000')),
    arbJsonValue(2),
    { maxKeys: 5 },
  );
}

/** A structurally valid op payload (contexts are random; causality is not simulated here). */
export function arbOpPayload(): fc.Arbitrary<OpPayload> {
  return fc
    .record({
      replicaId: arbReplicaId(),
      seq: fc.integer({ min: 1, max: 1000 }),
      lamport: fc.integer({ min: 1, max: 10_000 }),
      others: arbVersionVector(),
      collection: fc.constantFrom('notes', 'tasks', 'inspections'),
      recordId: fc.hexaString({ minLength: 32, maxLength: 32 }),
      kind: fc.constantFrom<'set' | 'delete'>('set', 'delete'),
      schemaVersion: fc.integer({ min: 1, max: 3 }),
      fields: arbFields(),
    })
    .map(({ others, ...p }) => {
      const context: Record<string, number> = { ...others };
      delete context[p.replicaId];
      if (p.seq > 1) context[p.replicaId] = p.seq - 1;
      return { ...p, context, fields: p.kind === 'delete' ? {} : p.fields };
    });
}

/** Internally consistent frontier entries with unique op IDs. */
export function arbFrontierEntries<V extends JsonValue>(
  value: fc.Arbitrary<V>,
  options: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<Array<FrontierEntry<V>>> {
  return fc
    .uniqueArray(
      fc.record({
        replicaId: fc.constantFrom(
          'aaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbb',
          'cccccccccccccccccccccccccc',
          'dddddddddddddddddddddddddd',
        ),
        seq: fc.integer({ min: 1, max: 5 }),
        lamport: fc.integer({ min: 1, max: 6 }),
        value,
      }),
      {
        minLength: options.minLength ?? 1,
        maxLength: options.maxLength ?? 8,
        selector: (e) => `${e.replicaId}:${e.seq}`,
      },
    )
    .map((list) => list.map((e) => ({ ...e, opId: { replicaId: e.replicaId, seq: e.seq } })));
}
