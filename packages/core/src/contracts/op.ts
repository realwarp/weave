import type { JsonValue, OpId, ReplicaId, VersionVector } from './json.js';

/**
 * The exact object that is hashed (D2, D7). `hash` and `wallTime` are never part of it.
 */
export interface OpPayload {
  /** The replica that created this operation. */
  readonly replicaId: ReplicaId;
  /** 1, 2, 3, ... per replica, no gaps (D1). Global per replica, not per collection. */
  readonly seq: number;
  /** 1 + max lamport over all ACCEPTED ops at write time (D2). */
  readonly lamport: number;
  /** The writer's full ACCEPTED version vector at write time (D2). */
  readonly context: VersionVector;
  /** The collection name of the record being modified. */
  readonly collection: string;
  /** The record ID being modified. */
  readonly recordId: string;
  /**
   * `set` or `delete`; [ADV] `restore` (0.2.0, D6) cancels every delete op of the record that
   * happens before it. A `restore` is accepted only by collections that enable it
   * (`deletes.restore`); elsewhere it is rejected with `NOT_SUPPORTED`.
   */
  readonly kind: 'set' | 'delete' | 'restore';
  /** The schema version of the record at the time of the operation. */
  readonly schemaVersion: number;
  /** Field name to new value. Empty for `delete` and `restore`. */
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface Op extends OpPayload {
  /** Lowercase hex SHA-256 of `encodeCanonical(OpPayload)` (D2). */
  readonly hash: string;
  /** Display only. Not hashed, never read by the engine (A5). */
  readonly wallTime?: number;
}

/** One entry of `collection.history(recordId)` (R2.5, design 6.0). */
export interface OpHistoryEntry {
  /** The identity of this operation. */
  readonly opId: OpId;
  /** The kind of operation (`restore` only with the [ADV] feature). */
  readonly kind: 'set' | 'delete' | 'restore';
  /** The Lamport timestamp of this operation. */
  readonly lamport: number;
  /** The schema version of the record at the time of the operation. */
  readonly schemaVersion: number;
  /** Exactly as written (not migrated). Empty for delete. */
  readonly fields: Readonly<Record<string, JsonValue>>;
  /** The writer's version vector at write time. */
  readonly context: VersionVector;
  /** IDs of the other ops of this record that are concurrent with this op (D3), in D4 order. */
  readonly concurrentWith: readonly OpId[];
  /** Display only. Not hashed, never read by the engine (A5). */
  readonly wallTime?: number;
}
