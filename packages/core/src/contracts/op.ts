import type { JsonValue, OpId, ReplicaId, VersionVector } from './json.js';

/**
 * The exact object that is hashed (D2, D7). `hash` and `wallTime` are never part of it.
 */
export interface OpPayload {
  readonly replicaId: ReplicaId;
  /** 1, 2, 3, ... per replica, no gaps (D1). Global per replica, not per collection. */
  readonly seq: number;
  /** 1 + max lamport over all ACCEPTED ops at write time (D2). */
  readonly lamport: number;
  /** The writer's full ACCEPTED version vector at write time (D2). */
  readonly context: VersionVector;
  readonly collection: string;
  readonly recordId: string;
  /** `restore` is reserved for [ADV] and is rejected with NOT_SUPPORTED in the MVP. */
  readonly kind: 'set' | 'delete';
  readonly schemaVersion: number;
  /** Field name to new value. Empty for `delete`. */
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
  readonly opId: OpId;
  readonly kind: 'set' | 'delete';
  readonly lamport: number;
  readonly schemaVersion: number;
  /** Exactly as written (not migrated). Empty for delete. */
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly context: VersionVector;
  /** IDs of the other ops of this record that are concurrent with this op (D3), in D4 order. */
  readonly concurrentWith: readonly OpId[];
  readonly wallTime?: number;
}
