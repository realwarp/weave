import type { JsonValue, OpId } from './json.js';

/** A conflict record (D8). Derived data, never a source of truth. */
export interface ConflictRecord {
  /** SHA-256 over the canonical encoding of the sorted frontier op IDs (D8). */
  readonly conflictId: string;
  readonly kind: 'field' | 'delete';
  readonly collection: string;
  readonly recordId: string;
  /** Field conflicts only. */
  readonly field?: string;
  /** Sorted by D4 order. `value` is present for field conflicts. */
  readonly frontier: ReadonlyArray<{ readonly opId: OpId; readonly value?: JsonValue }>;
  /** Field conflicts only: the resolved value. */
  readonly resolved?: JsonValue;
  readonly status: 'open' | 'superseded';
}

/** The materialized state of one record, stored at `rec/<collection>/<recordId>` (design 3.4). */
export interface DerivedRecord {
  readonly deleted: boolean;
  /** Empty if deleted. */
  readonly fields: Readonly<
    Record<string, { readonly value: JsonValue; readonly frontier: readonly OpId[] }>
  >;
  /** Current (open) conflicts only. */
  readonly conflicts: readonly ConflictRecord[];
  /** Every conflict ID of this record's history log, open and superseded (design 6.1). */
  readonly conflictHistoryIds: readonly string[];
}

/** Stored at `mut/<mutationId>` in the same transaction as the op (R5.4). */
export interface MutationRecord {
  /** Hash of `{collection, kind, recordId, fields}` of the call (design 4). */
  readonly payloadHash: string;
  readonly opId: OpId;
  readonly recordId: string;
}

export interface Hashes {
  /** Hash of all resolved record state (D7). */
  readonly state: string;
  /** Hash of the sorted hashes of all accepted ops (D7). */
  readonly ops: string;
  /** Hash of the sorted open conflicts with their resolved values (D7). */
  readonly conflicts: string;
}
