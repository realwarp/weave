import type { ErrorCode, WeaveError } from './errors.js';
import type { ReplicaId, VersionVector } from './json.js';

/** Map of collection name to the highest schema version the sender supports (R4.10). */
export type Support = Readonly<Record<string, number>>;

/** An origin whose delivery stopped at its first unreadable op (R4.10). */
export interface BlockedOrigin {
  /** The replica ID that is blocked. */
  readonly origin: ReplicaId;
  /** The `seq` of the first op the receiver cannot read. */
  readonly seq: number;
  /** The collection name that cannot be read. */
  readonly collection: string;
  /** The schema version the receiver would need to support. */
  readonly requiredVersion: number;
  /** Direction of the sync operation. */
  readonly direction: 'pull' | 'push';
}

/** A schema-prefix rejection (`SCHEMA_TOO_NEW`) reported to the sender. */
export interface Rejection {
  /** The replica ID that was rejected. */
  readonly origin: ReplicaId;
  /** The op sequence number that was rejected. */
  readonly seq: number;
  /** The error code explaining the rejection. */
  readonly code: ErrorCode;
}

/** An origin whose atomic batch was rejected by validation or integrity failure (design 7.3). */
export interface RejectedOrigin {
  /** The replica ID whose batch was rejected. */
  readonly origin: ReplicaId;
  /** The error code explaining the rejection. */
  readonly code: ErrorCode;
  /** Direction of the sync operation. */
  readonly direction: 'pull' | 'push';
}

/** Request to pull ops from a remote peer. */
export interface PullRequest {
  /** The requesting replica's ID. */
  readonly replicaId: ReplicaId;
  /** The puller's accepted vector. The endpoint sends what lies beyond it. */
  readonly vector: VersionVector;
  /** The collections and schema versions the puller supports. */
  readonly support: Support;
  /** Maximum ops to send. `0` is a pure vector exchange (verification step, design 8.2). */
  readonly limit: number;
  /** If specified, only sync these origins. */
  readonly origins?: readonly ReplicaId[];
}

/** Response to a pull request. */
export interface PullResponse {
  /** The endpoint replica's ID. */
  readonly endpointId: ReplicaId;
  /** The endpoint's own durable (accepted) vector. */
  readonly durable: VersionVector;
  /** The collections and schema versions the endpoint supports, or `*` if unknown. */
  readonly support: Support | '*';
  /** Canonical op lines, one origin after another, ascending `seq` per origin. */
  readonly ops: readonly string[];
  /** Origins that could not be synced due to schema version mismatch. */
  readonly blocked: readonly BlockedOrigin[];
  /** More ops are available; client should continue syncing. */
  readonly more: boolean;
}

/** Request to push ops to a remote peer. */
export interface PushRequest {
  /** The requesting replica's ID. */
  readonly replicaId: ReplicaId;
  /** The collections and schema versions the pusher supports. */
  readonly support: Support;
  /** Canonical op lines. The sync engine always sends ops of ONE origin per request. */
  readonly ops: readonly string[];
}

/** Response to a push request. */
export interface PushResponse {
  /** The endpoint's own durable vector after handling the request. */
  readonly durable: VersionVector;
  /** Ops that were rejected due to schema or validation errors. */
  readonly rejected: readonly Rejection[];
  /** Map of origin ID to the first missing `seq` (a gap reported by the endpoint). */
  readonly need: Readonly<Record<ReplicaId, number>>;
  /** Origins that could not be synced due to schema version mismatch. */
  readonly blocked: readonly BlockedOrigin[];
}

/** Request to acknowledge the durable vector after a successful sync. */
export interface AckRequest {
  /** The requesting replica's ID. */
  readonly replicaId: ReplicaId;
  /** The requester's own durable accepted vector, sent after it committed what it received. */
  readonly durable: VersionVector;
}

/** One protocol for relays and replicas (design 8.1). */
export interface SyncEndpoint {
  /** Pull ops from the remote peer. */
  pull(request: PullRequest): Promise<PullResponse>;
  /** Push ops to the remote peer. */
  push(request: PushRequest): Promise<PushResponse>;
  /** Acknowledge the durable vector after a successful sync. */
  ack(request: AckRequest): Promise<void>;
}

/** Summary statistics from a sync operation. */
export interface SyncCounts {
  /** Number of verification rounds completed. */
  readonly rounds: number;
  /** Number of ops pulled from the remote peer. */
  readonly pulled: number;
  /** Number of ops pushed to the remote peer. */
  readonly pushed: number;
  /** Number of duplicate ops received. */
  readonly duplicates: number;
  /** Number of buffered ops promoted to accepted. */
  readonly promoted: number;
}

/**
 * Result of `replica.sync`. A discriminated union: every `partial` carries exactly one reason.
 * Priority when several conditions hold: failed > partial PEER_SCHEMA_OLDER > partial
 * NOT_SETTLED > complete (design 7.1, 8.2).
 */
export type SyncResult = SyncCounts &
  (
    | {
        /** Both sides hold the same ops at a verified sync point. */
        readonly status: 'complete';
        /** The common vector at the verified sync point (E == L_start == L_end). */
        readonly settled: VersionVector;
        /** Always empty for a complete sync. */
        readonly blocked: readonly [];
        /** Always empty for a complete sync. */
        readonly rejectedOrigins: readonly [];
      }
    | {
        /** Everything readable was exchanged, but some ops need a newer schema. */
        readonly status: 'partial';
        /** The receiver runs an older schema than some ops need (R4.10). */
        readonly code: 'PEER_SCHEMA_OLDER';
        /** Origins blocked due to schema version mismatch. */
        readonly blocked: readonly [BlockedOrigin, ...BlockedOrigin[]];
        /** Always empty for this result. */
        readonly rejectedOrigins: readonly [];
      }
    | {
        /** The data was exchanged, but the sides kept changing and no sync point was verified. */
        readonly status: 'partial';
        /** `maxRounds` ran out before `E == L_start == L_end` held (design 8.2). */
        readonly code: 'NOT_SETTLED';
        /** Always empty for this result. */
        readonly blocked: readonly [];
        /** Always empty for this result. */
        readonly rejectedOrigins: readonly [];
        /** The endpoint's vector after the last round. */
        readonly endpoint: VersionVector;
        /** The local replica's vector after the last round. */
        readonly local: VersionVector;
      }
    | {
        /** The sync stopped with an error or with rejected origins; committed data is kept. */
        readonly status: 'failed';
        /** The error code of the failure. */
        readonly code: ErrorCode;
        /** The error that caused the failure. */
        readonly error: WeaveError;
        /** Origins blocked due to schema version mismatch. */
        readonly blocked: readonly BlockedOrigin[];
        /** Origins whose batches were rejected by validation or integrity failure. */
        readonly rejectedOrigins: readonly RejectedOrigin[];
      }
  );

/** Options for configuring sync behavior. */
export interface SyncOptions {
  /** Maximum verification rounds (default 5, design 8.2). */
  readonly maxRounds?: number;
  /** Ops per pull or push batch (default 500, R4.6). */
  readonly batchSize?: number;
}

/** Value stored at `peer/<peerId>` (design 3.4). */
export interface PeerEntry {
  /** What the peer has confirmed holding durably. */
  readonly ackVector: VersionVector;
  /** The collections and schema versions the peer supports, or `*` if unknown. */
  readonly support: Support | '*';
  /** Display only: wall time of the last sync that ended `complete`; written ONLY by a complete sync. */
  readonly lastSyncWall?: number;
  /** Result of the most recent sync with this peer, whatever its status. */
  readonly lastResult?: SyncResult;
}

/** Result of `applyIncoming` for the sender of a batch (design 7.3). */
export interface ApplyResult {
  /** The receiver's accepted vector after the batch. */
  readonly vector: VersionVector;
  /** Schema-prefix rejections (SCHEMA_TOO_NEW) only. */
  readonly rejected: readonly Rejection[];
  /** Map of origin ID to the first missing `seq` (gap reported to the sender). */
  readonly need: Readonly<Record<ReplicaId, number>>;
  /** Origins blocked due to schema version mismatch. */
  readonly blocked: readonly BlockedOrigin[];
  /** Number of duplicate ops received. */
  readonly duplicates: number;
  /** Buffered ops that were promoted into the accepted log by this batch. */
  readonly promoted: number;
  /** Number of ops newly accepted, including promotions. */
  readonly applied: number;
}

/** Applies a batch of canonical op lines. All-or-nothing for ordinary failures (design 7.3). */
export type ApplyIncoming = (lines: readonly string[], peerId: ReplicaId) => Promise<ApplyResult>;
