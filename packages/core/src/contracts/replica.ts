import type { Clock, Random, Scheduler } from './env.js';
import type { Logger, WeaveEvent } from './events.js';
import type { JsonValue, OpId, ReplicaId, VersionVector } from './json.js';
import type { OpHistoryEntry } from './op.js';
import type { CollectionDefinition, FieldSpec, InferRecord } from './schema.js';
import type { ConflictRecord, Hashes } from './state.js';
import type { MetaCompaction, StorageAdapter } from './storage.js';
import type {
  ApplyIncoming,
  AuthContext,
  AuthorizeHook,
  CompactionInfo,
  PeerEntry,
  Snapshot,
  Support,
  SyncEndpoint,
  SyncOptions,
  SyncResult,
} from './sync.js';

/** Required on every create, update and delete (R5.4). One stable ID per user intent. */
export interface WriteOptions {
  /** A unique identifier for this user intent, used for idempotent retries. */
  readonly mutationId: string;
}

/** Result of a write operation. */
export interface WriteResult {
  /** The ID of the record that was created or updated. */
  readonly recordId: string;
  /** The ID of the operation that was created. */
  readonly opId: OpId;
  /** True when a stored `mutationId` result was returned and no new op was created. */
  readonly replayed: boolean;
}

/** A record view with its current value and conflicts. */
export interface RecordView<T> {
  /** The unique ID of the record. */
  readonly id: string;
  /** The current resolved value of the record. */
  readonly value: T;
  /** List of current conflicts affecting this record. */
  readonly conflicts: readonly ConflictRecord[];
}

/** Query options for filtering and sorting records. */
export interface Query<T> {
  /** Field equality filters (R1.5). */
  readonly where?: Partial<T>;
  /** Field to sort by. */
  readonly orderBy?: keyof T & string;
  /** Sort direction. */
  readonly direction?: 'asc' | 'desc';
  /** Include deleted records (default false). */
  readonly includeDeleted?: boolean;
}

/** A typed handle on one collection. Every storage-backed call returns a Promise. */
export interface Collection<T> {
  /** Create a new record. */
  create(value: T, options: WriteOptions): Promise<WriteResult>;
  /** Update an existing record. */
  update(recordId: string, patch: Partial<T>, options: WriteOptions): Promise<WriteResult>;
  /** Delete a record. */
  delete(recordId: string, options: WriteOptions): Promise<WriteResult>;
  /**
   * [ADV] Undeletes a record: the restore cancels every delete op this replica holds for it (D6).
   * `NOT_SUPPORTED` unless the collection enables `deletes.restore`.
   */
  restore(recordId: string, options: WriteOptions): Promise<WriteResult>;
  /** Get a single record by ID. */
  get(recordId: string): Promise<RecordView<T> | undefined>;
  /** Query records with optional filtering and sorting. */
  query(query?: Query<T>): Promise<Array<RecordView<T>>>;
  /** Operation history of one record in D4 order, deleted records included (R2.5). */
  history(recordId: string): Promise<OpHistoryEntry[]>;
}

/** Filter for conflict queries. */
export interface ConflictFilter {
  /** Filter by collection name. */
  readonly collection?: string;
  /** Filter by record ID. */
  readonly recordId?: string;
}

/** API for accessing conflicts. */
export interface ConflictApi {
  /** Open conflicts, derived from stored records. */
  current(filter?: ConflictFilter): Promise<ConflictRecord[]>;
  /** The deterministic conflict history log, open and superseded (D8). */
  history(filter?: ConflictFilter): Promise<ConflictRecord[]>;
}

/** A change notification (R3.3). */
export interface ChangeEvent {
  /** Where the change came from. */
  readonly source: 'local' | 'sync';
  /** The collection that changed. */
  readonly collection: string;
  /** The ID of the record that changed. */
  readonly recordId: string;
  /** What kind of change occurred (`restore` only with the [ADV] feature). */
  readonly kind: 'set' | 'delete' | 'restore';
}

/** Current status of the replica. */
export interface ReplicaStatus {
  /** Current operational state. */
  readonly state: 'idle' | 'syncing' | 'failed';
  /** The accepted version vector. */
  readonly vector: VersionVector;
  /** Ops in `pend/`: buffered, NOT accepted (design 3.5). */
  readonly pendingBuffer: number;
  /** Map of peer IDs to their sync status. */
  readonly peers: Readonly<
    Record<
      ReplicaId,
      {
        /** What the peer has confirmed holding durably. */
        readonly ackVector: VersionVector;
        /** Accepted ops the peer has not acknowledged. */
        readonly pendingOps: number;
        /** The result of the last sync with this peer, whatever its status. */
        readonly lastResult?: SyncResult;
        /** Wall time of the last `complete` sync (display only, never used for ordering). */
        readonly lastSyncWall?: number;
      }
    >
  >;
  /** [ADV] Present once this replica has learned a horizon or compacted (R3.6 to R3.10). */
  readonly compaction?: MetaCompaction;
  /**
   * [ADV] Present while this replica holds ops it cannot read yet (R8.7, `holdNewerSchema`):
   * an app update is needed to apply them.
   */
  readonly held?: HeldStatus;
  /** [ADV] Peers currently banned for sending invalid data (R10.5). Absent when none. */
  readonly bans?: readonly BanStatus[];
}

/** [ADV] Held newer-schema ops waiting for an app update (R8.7). */
export interface HeldStatus {
  /** Number of held ops this code cannot read. */
  readonly ops: number;
  /** Per collection, the highest schema version a held op needs. */
  readonly needs: Readonly<Record<string, number>>;
  /**
   * Held ops that became readable after an upgrade but failed schema validation. They stay
   * stored and never enter state; their writer was faulty. Absent when zero.
   */
  readonly invalid?: number;
}

/**
 * [ADV] Compaction settings (R3.6 to R3.14). Compaction is off unless `enabled` is true. It
 * assumes every registered member follows the acknowledgement protocol; it is not safe against a
 * member that over-claims (ADR-0006).
 */
export interface CompactionOptions {
  /** Allow `compact()` (default false). */
  readonly enabled: boolean;
  /**
   * A closed replica set for compaction without a relay: every member's ID, this replica
   * included. The horizon is then the minimum of this replica's vector and every other member's
   * acknowledged vector. Without it, only a horizon published by a relay is used.
   */
  readonly members?: readonly ReplicaId[];
}

/** [ADV] Result of `replica.bootstrap()`. */
export interface BootstrapReport {
  /** The replica the snapshot came from. */
  readonly source: ReplicaId;
  /** Op lines imported. */
  readonly ops: number;
  /** Records derived from them. */
  readonly records: number;
  /** The vector this replica holds after the import. */
  readonly vector: VersionVector;
}

/** [ADV] Result of `replica.compact()`. */
export interface CompactionReport {
  /** The horizon that was used. */
  readonly horizon: VersionVector;
  /** Number of ops discarded by this call. */
  readonly removedOps: number;
  /** Number of records that lost ops. */
  readonly records: number;
  /** Per origin, the highest `seq` discarded so far. */
  readonly compactedThrough: VersionVector;
}

/** Options for creating a new replica. */
export interface CreateReplicaOptions {
  /** Storage adapter for persistence. */
  readonly storage: StorageAdapter;
  /** Collection definitions. */
  readonly collections: ReadonlyArray<CollectionDefinition<Record<string, FieldSpec>>>;
  /** Optional event logger. */
  readonly logger?: Logger;
  /** Optional wall-clock source (defaults to platform time). */
  readonly clock?: Clock;
  /** Optional randomness source (defaults to platform crypto). */
  readonly random?: Random;
  /** Optional scheduler for timing operations. */
  readonly scheduler?: Scheduler;
  /** [ADV] Compaction settings; compaction is off by default (R3.12). */
  readonly compaction?: CompactionOptions;
  /**
   * [ADV] Hold ops this replica cannot read yet (an unknown collection or a newer schema
   * version) instead of blocking their origin (R8.7). Held ops are stored and counted, excluded
   * from visible state, reported in `status().held`, and applied after an upgrade. Default false:
   * the prefix rule of R4.10 applies.
   */
  readonly holdNewerSchema?: boolean;
  /**
   * [ADV] Authorization hook (R16.4), called before this replica applies incoming ops (pulled or
   * pushed to its endpoint) and before it sends ops (pushes, or pulls served by its endpoint).
   * Anything but `true` denies with `UNAUTHORIZED`; nothing changes. Absent: allow all.
   */
  readonly authorize?: AuthorizeHook;
  /**
   * [ADV] Peer ban (R10.5): a peer that repeatedly sends invalid data is refused for a while,
   * measured with the injected monotonic scheduler. Off unless `enabled` is true.
   */
  readonly ban?: BanOptions;
}

/** [ADV] Peer ban settings (R10.5). */
export interface BanOptions {
  /** Turn the ban on (default false). */
  readonly enabled: boolean;
  /** Strikes within `windowMs` that ban a peer (default 3). */
  readonly threshold?: number;
  /** How long strikes count, in monotonic ms (default 60000). */
  readonly windowMs?: number;
  /** How long a ban lasts, in monotonic ms (default 300000). */
  readonly banMs?: number;
}

/** [ADV] One banned peer, as reported by `status()` (R10.5). */
export interface BanStatus {
  /** The banned peer's replica ID. */
  readonly peer: ReplicaId;
  /** Monotonic milliseconds until the ban ends. */
  readonly remainingMs: number;
}

/** [ADV] Options of `replica.endpoint()` (R16.3). */
export interface EndpointOptions {
  /**
   * The caller as authenticated by the transport that serves this endpoint. Every request's
   * claimed `replicaId`, and the origin of every pushed op, must be one it may act as;
   * otherwise `UNAUTHORIZED`. It is bound here, never read from a request.
   */
  readonly auth?: AuthContext;
}

/** The main interface for interacting with a WEAVE replica. */
export interface Replica {
  /** The unique ID of this replica. */
  readonly id: ReplicaId;
  /** Get a typed handle for a collection. */
  collection<D extends CollectionDefinition<Record<string, FieldSpec>>>(
    definition: D,
  ): Collection<InferRecord<D>>;
  /** Access to the conflict API. */
  readonly conflicts: ConflictApi;
  /** Synchronous. Returns an unsubscribe function. */
  subscribe(listener: (change: ChangeEvent) => void): () => void;
  /** Sync with a remote endpoint. */
  sync(endpoint: SyncEndpoint, options?: SyncOptions): Promise<SyncResult>;
  /** An endpoint that serves this replica, for direct replica-to-replica sync (R4.3). */
  endpoint(options?: EndpointOptions): SyncEndpoint;
  /** Get the current replica status. */
  status(): Promise<ReplicaStatus>;
  /** Compute hashes of the current state. */
  hashes(): Promise<Hashes>;
  /** Re-derive all records from the op log (R7.4). Does not touch ops. */
  rebuild(): Promise<void>;
  /** Generate a new mutation ID using the replica's random source (R5.4). */
  newMutationId(): string;
  /**
   * [ADV] Discards ops covered by the horizon that no longer affect state (R3.8). Throws
   * `NOT_SUPPORTED` unless compaction is enabled and a horizon is known.
   */
  compact(): Promise<CompactionReport>;
  /**
   * [ADV] Removes a member of a closed replica set from horizon calculations and refuses its later
   * ops (R3.10). With a relay, call `RelayCore.removePeer` instead; the relay's list syncs here.
   */
  removePeer(replicaId: ReplicaId): Promise<void>;
  /** [ADV] A snapshot of this replica's op set and vectors for bootstrapping others (R4.8). */
  exportSnapshot(): Promise<Snapshot>;
  /**
   * [ADV] Bootstraps an EMPTY replica from a snapshot, or from an endpoint that serves one, then
   * normal sync continues (R4.8). A removed device rejoins only through a new, empty replica with
   * a fresh replica ID. Throws `VALIDATION_FAILED` when this replica already holds data.
   */
  bootstrap(source: Snapshot | SyncEndpoint): Promise<BootstrapReport>;
  /** Close the replica and release resources. */
  close(): Promise<void>;
}

/**
 * The accessors the sync engine needs from the replica (design 18.2). Declared here so that the
 * Core engine owner and the Synchronization owner meet at one interface.
 */
export interface SyncHost {
  /** The unique ID of this replica. */
  readonly replicaId: ReplicaId;
  /** Wall-clock source for display values. */
  readonly clock: Clock;
  /** Randomness source. */
  readonly random: Random;
  /** Scheduler for timing operations. */
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
  ): Promise<
    Array<{
      /** The op's sequence number. */
      seq: number;
      /** The op's collection (envelope field). */
      collection: string;
      /** The schema version the op was written with (envelope field). */
      schemaVersion: number;
      /** The canonical op line, unchanged. */
      line: string;
    }>
  >;
  /** Apply incoming ops from a sync batch. */
  applyIncoming: ApplyIncoming;
  /** Read peer state. */
  readPeer(peerId: string): Promise<PeerEntry | undefined>;
  /** Write peer state. */
  writePeer(peerId: string, entry: PeerEntry): Promise<void>;
  /** Count of buffered ops. */
  pendingBufferSize(): Promise<number>;
  /** Runs `fn` under the per-replica mutex. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Emit an event to the logger. */
  emit(event: WeaveEvent): void;
  /** Update the replica's state. */
  setState(state: ReplicaStatus['state']): void;
  /** [ADV] Records compaction state an endpoint published (horizon, removed list). Optional. */
  noteCompaction?(info: CompactionInfo): Promise<void>;
  /** [ADV] True when this replica holds unreadable ops (R8.7), so peers send it every op. */
  holdsNewer?(): boolean;
  /**
   * [ADV] Peer ban (R10.5). Called with the endpoint's ID before pulled ops are applied: throws
   * `PEER_BANNED` when that peer is banned. Optional.
   */
  assertPeerAllowed?(peer: ReplicaId): void;
  /** [ADV] Records that `peer` sent invalid data in one sync (one strike, R10.5). Optional. */
  notePeerInvalid?(peer: ReplicaId): void;
  /** [ADV] Runs the authorization hook before ops are sent to `peer` (R16.4). Optional. */
  authorizeSend?(peer: ReplicaId, lines: readonly string[]): Promise<void>;
}

/** Re-exported for convenience in adapter and app code. */
export type { JsonValue };
