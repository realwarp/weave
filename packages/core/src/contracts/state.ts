import type { JsonValue, OpId } from './json.js';

/**
 * A conflict record (D8). Derived data, never a source of truth.
 */
export interface ConflictRecord {
  /** SHA-256 over the canonical encoding of the sorted frontier op IDs (D8). */
  readonly conflictId: string;
  /** Whether this is a field conflict or a delete conflict. */
  readonly kind: 'field' | 'delete';
  /** The collection name of the record with the conflict. */
  readonly collection: string;
  /** The record ID with the conflict. */
  readonly recordId: string;
  /** Field conflicts only. */
  readonly field?: string;
  /** Sorted by D4 order. `value` is present for field conflicts. */
  readonly frontier: ReadonlyArray<{
    /** One of the concurrent ops. */
    readonly opId: OpId;
    /** The value that op wrote (field conflicts only). */
    readonly value?: JsonValue;
  }>;
  /** Field conflicts only: the resolved value. */
  readonly resolved?: JsonValue;
  /** Whether this conflict is still open or was superseded by a later op. */
  readonly status: 'open' | 'superseded';
}

/**
 * The materialized state of one record, stored at `rec/<collection>/<recordId>` (design 3.4).
 */
export interface DerivedRecord {
  /** Whether the record has been deleted. */
  readonly deleted: boolean;
  /** Empty if deleted. */
  readonly fields: Readonly<
    Record<
      string,
      {
        /** The resolved value of the field. */
        readonly value: JsonValue;
        /** The ops that set the field and that no later op on it follows (D5). */
        readonly frontier: readonly OpId[];
      }
    >
  >;
  /** Current (open) conflicts only. */
  readonly conflicts: readonly ConflictRecord[];
  /** Every conflict ID of this record's history log, open and superseded (design 6.1). */
  readonly conflictHistoryIds: readonly string[];
}

/**
 * Stored at `mut/<mutationId>` in the same transaction as the op (R5.4).
 */
export interface MutationRecord {
  /** Hash of `{collection, kind, recordId, fields}` of the call (design 4). */
  readonly payloadHash: string;
  /** The identity of the op that resulted from this mutation. */
  readonly opId: OpId;
  /** The record ID that was modified. */
  readonly recordId: string;
}

/**
 * Hashes of the global state for verification and debugging (D7).
 */
export interface Hashes {
  /** Hash of all resolved record state (D7). */
  readonly state: string;
  /** Hash of the sorted hashes of all accepted ops (D7). */
  readonly ops: string;
  /** Hash of the sorted open conflicts with their resolved values (D7). */
  readonly conflicts: string;
}
