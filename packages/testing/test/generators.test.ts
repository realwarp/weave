import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REPLICA_ID_PATTERN, toCanonical } from '@weave/core/protocol';
import {
  arbBatches,
  arbFrontierEntries,
  arbJsonValue,
  arbOpPayload,
  arbReplicaId,
} from '../src/generators/index.js';

describe('generators', () => {
  it('replica IDs match the pattern and payloads are internally consistent', () => {
    fc.assert(fc.property(arbReplicaId(), (id) => REPLICA_ID_PATTERN.test(id)));
    fc.assert(
      fc.property(arbOpPayload(), (p) => {
        expect(p.context[p.replicaId] ?? 0).toBe(p.seq - 1);
        if (p.kind === 'delete') expect(p.fields).toEqual({});
      }),
    );
  });

  it('JSON values are canonically encodable', () => {
    fc.assert(fc.property(arbJsonValue(), (v) => void toCanonical(v)));
  });

  it('frontier entries have unique, matching op IDs', () => {
    fc.assert(
      fc.property(arbFrontierEntries(fc.integer()), (entries) => {
        const ids = entries.map((e) => `${e.opId.replicaId}:${e.opId.seq}`);
        expect(new Set(ids).size).toBe(ids.length);
        for (const e of entries) expect(e.opId).toEqual({ replicaId: e.replicaId, seq: e.seq });
      }),
    );
  });

  it('batches deliver every line, in any order, with optional duplicates', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    fc.assert(
      fc.property(arbBatches(lines, { duplicates: true }), (batches) => {
        const flat = batches.flat();
        expect(new Set(flat)).toEqual(new Set(lines));
        expect(batches.every((b) => b.length > 0)).toBe(true);
      }),
    );
    fc.assert(fc.property(arbBatches(lines), (batches) => batches.flat().length === lines.length));
  });
});
