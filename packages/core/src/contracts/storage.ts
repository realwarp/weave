import type { ReplicaId, VersionVector } from './json.js';

/**
 * Storage adapter contract (design 9). A `rw` transaction is atomic and durable when
 * `transaction` resolves. `fn` may only await calls on `tx` (IndexedDB closes idle transactions).
 * Keys are ASCII and sort byte-wise; `scan` returns ascending order.
 */
export interface StorageTx {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): void;
  delete(key: string): void;
  scan(
    prefix: string,
    options?: { readonly after?: string; readonly limit?: number },
  ): Promise<Array<[string, string]>>;
}

export interface StorageAdapter {
  open(): Promise<void>;
  close(): Promise<void>;
  transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T>;
}

/** Value stored at `meta/state` (accepted ops only, design 3.4, 3.5). */
export interface MetaState {
  readonly vector: VersionVector;
  readonly maxLamport: number;
  /** Incremented by every committed transaction of the engine (design 7.2). */
  readonly commit: number;
}

/** Value stored at `meta/replica`. */
export interface MetaReplica {
  readonly replicaId: ReplicaId;
}

/** Value stored at `meta/schema`: the schema version the derived state was built at. */
export type MetaSchema = Readonly<Record<string, number>>;

const SEQ_WIDTH = 12;

/** Zero-padded sequence number so that string order equals numeric order. */
export function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_WIDTH, '0');
}

/** Storage key layout (design 3.4). Every key is ASCII. */
export const keys = {
  metaReplica: 'meta/replica',
  metaState: 'meta/state',
  metaSchema: 'meta/schema',
  op: (origin: ReplicaId, seq: number): string => `op/${origin}/${padSeq(seq)}`,
  opPrefix: (origin: ReplicaId): string => `op/${origin}/`,
  rop: (collection: string, recordId: string, origin: ReplicaId, seq: number): string =>
    `rop/${collection}/${recordId}/${origin}/${padSeq(seq)}`,
  ropPrefix: (collection: string, recordId: string): string => `rop/${collection}/${recordId}/`,
  rec: (collection: string, recordId: string): string => `rec/${collection}/${recordId}`,
  recPrefix: (collection?: string): string =>
    collection === undefined ? 'rec/' : `rec/${collection}/`,
  mut: (mutationId: string): string => `mut/${mutationId}`,
  pend: (origin: ReplicaId, seq: number): string => `pend/${origin}/${padSeq(seq)}`,
  pendPrefix: (origin?: ReplicaId): string => (origin === undefined ? 'pend/' : `pend/${origin}/`),
  peer: (peerId: string): string => `peer/${peerId}`,
  peerPrefix: 'peer/',
  notified: (conflictId: string): string => `notified/${conflictId}`,
  notifiedPrefix: 'notified/',
} as const;
