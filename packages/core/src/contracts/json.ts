/**
 * Basic value and identity types shared by every WEAVE package (design 3.1, 3.2, D7).
 */

/** A value that survives canonical encoding (D7). Anything else is rejected with UNSUPPORTED_VALUE. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 128-bit random value, 26 base32 characters `[a-z2-7]`, created once per replica (A1). */
export type ReplicaId = string;

/** The identity of one operation: `(replicaId, seq)` (D1). */
export interface OpId {
  /** The replica that created this operation. */
  readonly replicaId: ReplicaId;
  /** Sequential number assigned by the replica, starting at 1. */
  readonly seq: number;
}

/**
 * Highest contiguous accepted `seq` per origin replica. A missing origin counts as 0.
 * Pending (buffered) ops are NOT part of any version vector (design 3.5).
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;
