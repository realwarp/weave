import type { Clock, Random, Scheduler } from './env.js';
import type { Logger, WeaveEvent } from './events.js';
import type { JsonValue, OpId, ReplicaId, VersionVector } from './json.js';
import type { OpHistoryEntry } from './op.js';
import type { CollectionDefinition, FieldSpec, InferRecord } from './schema.js';
import type { ConflictRecord, Hashes } from './state.js';
import type { StorageAdapter } from './storage.js';
import type {
  ApplyIncoming,
  PeerEntry,
  Support,
  SyncEndpoint,
  SyncOptions,
  SyncResult,
} from './sync.js';

/** Required on every create, update and delete (R5.4). One stable ID per user intent. */
export interface WriteOptions {
  readonly mutationId: string;
}

export interface WriteResult {
  readonly recordId: string;
  readonly opId: OpId;
  /** True when a stored `mutationId` result was returned and no new op was created. */
  readonly replayed: boolean;
}

export interface RecordView<T> {
  readonly id: string;
  readonly value: T;
  readonly conflicts: readonly ConflictRecord[];
}

export interface Query<T> {
  /** Field equality filters (R1.5). */
  readonly where?: Partial<T>;
  readonly orderBy?: keyof T & string;
  readonly direction?: 'asc' | 'desc';
  /** Include deleted records (default false). */
  readonly includeDeleted?: boolean;
}

/** A typed handle on one collection. Every storage-backed call returns a Promise. */
export interface Collection<T> {
  create(value: T, options: WriteOptions): Promise<WriteResult>;
  update(recordId: string, patch: Partial<T>, options: WriteOptions): Promise<WriteResult>;
  delete(recordId: string, options: WriteOptions): Promise<WriteResult>;
  get(recordId: string): Promise<RecordView<T> | undefined>;
  query(query?: Query<T>): Promise<Array<RecordView<T>>>;
  /** Operation history of one record in D4 order, deleted records included (R2.5). */
  history(recordId: string): Promise<OpHistoryEntry[]>;
}

export interface ConflictFilter {
  readonly collection?: string;
  readonly recordId?: string;
}

export interface ConflictApi {
  /** Open conflicts, derived from stored records. */
  current(filter?: ConflictFilter): Promise<ConflictRecord[]>;
  /** The deterministic conflict history log, open and superseded (D8). */
  history(filter?: ConflictFilter): Promise<ConflictRecord[]>;
}

/** A change notification (R3.3). */
export interface ChangeEvent {
  readonly source: 'local' | 'sync';
  readonly collection: string;
  readonly recordId: string;
  readonly kind: 'set' | 'delete';
}

export interface ReplicaStatus {
  readonly state: 'idle' | 'syncing' | 'failed';
  readonly vector: VersionVector;
  /** Ops in `pend/`: buffered, NOT accepted (design 3.5). */
  readonly pendingBuffer: number;
  readonly peers: Readonly<
    Record<
      ReplicaId,
      {
        readonly ackVector: VersionVector;
        /** Accepted ops the peer has not acknowledged. */
        readonly pendingOps: number;
        readonly lastResult?: SyncResult;
        readonly lastSyncWall?: number;
      }
    >
  >;
}

export interface CreateReplicaOptions {
  readonly storage: StorageAdapter;
  readonly collections: ReadonlyArray<CollectionDefinition<Record<string, FieldSpec>>>;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly scheduler?: Scheduler;
}

export interface Replica {
  readonly id: ReplicaId;
  collection<D extends CollectionDefinition<Record<string, FieldSpec>>>(
    definition: D,
  ): Collection<InferRecord<D>>;
  readonly conflicts: ConflictApi;
  /** Synchronous. Returns an unsubscribe function. */
  subscribe(listener: (change: ChangeEvent) => void): () => void;
  sync(endpoint: SyncEndpoint, options?: SyncOptions): Promise<SyncResult>;
  /** An endpoint that serves this replica, for direct replica-to-replica sync (R4.3). */
  endpoint(): SyncEndpoint;
  status(): Promise<ReplicaStatus>;
  hashes(): Promise<Hashes>;
  /** Re-derive all records from the op log (R7.4). Does not touch ops. */
  rebuild(): Promise<void>;
  /** Uses the `Random` the replica was created with (R5.4). */
  newMutationId(): string;
  close(): Promise<void>;
}

/**
 * The accessors the sync engine needs from the replica (design 18.2). Declared here so that the
 * Core engine owner and the Synchronization owner meet at one interface.
 */
export interface SyncHost {
  readonly replicaId: ReplicaId;
  readonly clock: Clock;
  readonly random: Random;
  readonly scheduler: Scheduler;
  /** What this replica can read, per collection. */
  support(): Support;
  /** Accepted vector, read fresh from storage. */
  readVector(): Promise<VersionVector>;
  /**
   * Accepted ops of one origin with `seq > afterSeq`, ascending, as canonical lines plus the
   * envelope fields the prefix rule needs.
   */
  readOps(
    origin: ReplicaId,
    afterSeq: number,
    limit: number,
  ): Promise<Array<{ seq: number; collection: string; schemaVersion: number; line: string }>>;
  applyIncoming: ApplyIncoming;
  readPeer(peerId: string): Promise<PeerEntry | undefined>;
  writePeer(peerId: string, entry: PeerEntry): Promise<void>;
  /** Count of buffered ops. */
  pendingBufferSize(): Promise<number>;
  /** Runs `fn` under the per-replica mutex. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  emit(event: WeaveEvent): void;
  setState(state: ReplicaStatus['state']): void;
}

/** Re-exported for convenience in adapter and app code. */
export type { JsonValue };
