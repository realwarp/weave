import type { ReplicaId, VersionVector } from './json.js';

/**
 * Storage adapter contract (design 9). A `rw` transaction is atomic and durable when
 * `transaction` resolves. `fn` may only await calls on `tx` (IndexedDB closes idle transactions).
 * Keys are ASCII and sort byte-wise; `scan` returns ascending order.
 */
export interface StorageTx {
  /** Retrieves the value for a given key, or `undefined` if not found. */
  get(key: string): Promise<string | undefined>;
  /** Stores a key-value pair. */
  put(key: string, value: string): void;
  /** Deletes a key-value pair. */
  delete(key: string): void;
  /**
   * Returns all key-value pairs with the given prefix, in ascending order.
   * @param prefix The key prefix to scan.
   * @param options Optional pagination parameters.
   */
  scan(
    prefix: string,
    options?: { readonly after?: string; readonly limit?: number },
  ): Promise<Array<[string, string]>>;
}

/**
 * A storage adapter that supports read-only and read-write transactions.
 */
export interface StorageAdapter {
  /** Opens the storage adapter and prepares it for use. */
  open(): Promise<void>;
  /** Closes the storage adapter and releases any resources. */
  close(): Promise<void>;
  /**
   * Executes a function within a transaction.
   * @param mode `'ro'` for read-only, `'rw'` for read-write.
   * @param fn A function that receives a transaction object and returns a promise.
   */
  transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T>;
}

/**
 * Value stored at `meta/state` (accepted ops only, design 3.4, 3.5).
 */
export interface MetaState {
  /** The highest contiguous accepted `seq` per origin replica. */
  readonly vector: VersionVector;
  /** The maximum Lamport timestamp among all accepted ops. */
  readonly maxLamport: number;
  /** Incremented by every committed transaction of the engine (design 7.2). */
  readonly commit: number;
}

/**
 * Value stored at `meta/replica`. Contains the unique replica identifier.
 */
export interface MetaReplica {
  /** The 128-bit random replica identifier. */
  readonly replicaId: ReplicaId;
}

/**
 * Value stored at `meta/schema`: the schema version the derived state was built at.
 */
export type MetaSchema = Readonly<Record<string, number>>;

const SEQ_WIDTH = 12;

/** Zero-padded sequence number so that string order equals numeric order. */
export function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_WIDTH, '0');
}

/**
 * Storage key layout (design 3.4). Every key is ASCII.
 * Used to construct stable keys for storing ops, records, metadata, etc.
 */
export const keys = {
  /** The replica's identity (`MetaReplica`). */
  metaReplica: 'meta/replica',
  /** Accepted vector, max Lamport and commit counter (`MetaState`). */
  metaState: 'meta/state',
  /** Schema versions the derived state was built at (`MetaSchema`). */
  metaSchema: 'meta/schema',
  /** One accepted op line of `origin` at `seq`. */
  op: (origin: ReplicaId, seq: number): string => `op/${origin}/${padSeq(seq)}`,
  /** All accepted ops of one origin, in seq order. */
  opPrefix: (origin: ReplicaId): string => `op/${origin}/`,
  /** Per-record index entry: op `origin`/`seq` touches this record. */
  rop: (collection: string, recordId: string, origin: ReplicaId, seq: number): string =>
    `rop/${collection}/${recordId}/${origin}/${padSeq(seq)}`,
  /** All index entries of one record. */
  ropPrefix: (collection: string, recordId: string): string => `rop/${collection}/${recordId}/`,
  /** The derived state of one record (`DerivedRecord`). */
  rec: (collection: string, recordId: string): string => `rec/${collection}/${recordId}`,
  /** All derived records, or those of one collection. */
  recPrefix: (collection?: string): string =>
    collection === undefined ? 'rec/' : `rec/${collection}/`,
  /** The stored result of a write with this `mutationId` (R5.4). */
  mut: (mutationId: string): string => `mut/${mutationId}`,
  /** A buffered (not accepted) op waiting for a sequence gap to fill. */
  pend: (origin: ReplicaId, seq: number): string => `pend/${origin}/${padSeq(seq)}`,
  /** All buffered ops, or those of one origin. */
  pendPrefix: (origin?: ReplicaId): string => (origin === undefined ? 'pend/' : `pend/${origin}/`),
  /** What a peer has acknowledged and its last sync result (`PeerEntry`). */
  peer: (peerId: string): string => `peer/${peerId}`,
  /** All peer entries. */
  peerPrefix: 'peer/',
  /** Marks that a conflict notification was emitted (at most once, D8). */
  notified: (conflictId: string): string => `notified/${conflictId}`,
  /** All notification marks. */
  notifiedPrefix: 'notified/',
  /** [ADV] Compaction state of a replica (`MetaCompaction`). Absent until compaction is used. */
  metaCompaction: 'meta/compaction',
  /** [ADV] Conflict history entries of one record kept after its ops were compacted. */
  chist: (collection: string, recordId: string): string => `chist/${collection}/${recordId}`,
} as const;

/** [ADV] Value stored at `meta/compaction` (R3.6 to R3.10). */
export interface MetaCompaction {
  /** The last horizon learned from the relay (or computed for a closed replica set). */
  readonly horizon: VersionVector;
  /** Per origin, the highest `seq` this replica has discarded. */
  readonly compactedThrough: VersionVector;
  /** Removed members and the last `seq` still accepted from each. */
  readonly removed: Readonly<Record<ReplicaId, number>>;
}
