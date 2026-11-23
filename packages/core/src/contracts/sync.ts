import type { ErrorCode, WeaveError } from './errors.js';
import type { ReplicaId, VersionVector } from './json.js';

/** collection name to the highest schema version the sender supports (R4.10). */
export type Support = Readonly<Record<string, number>>;

/** An origin whose delivery stopped at its first unreadable op (R4.10). */
export interface BlockedOrigin {
  readonly origin: ReplicaId;
  /** The `seq` of the first op the receiver cannot read. */
  readonly seq: number;
  readonly collection: string;
  /** The schema version the receiver would need to support. */
  readonly requiredVersion: number;
  readonly direction: 'pull' | 'push';
}

/** A schema-prefix rejection (`SCHEMA_TOO_NEW`) reported to the sender. */
export interface Rejection {
  readonly origin: ReplicaId;
  readonly seq: number;
  readonly code: ErrorCode;
}

/** An origin whose atomic batch was rejected by validation or integrity failure (design 7.3). */
export interface RejectedOrigin {
  readonly origin: ReplicaId;
  readonly code: ErrorCode;
  readonly direction: 'pull' | 'push';
}

export interface PullRequest {
  readonly replicaId: ReplicaId;
  /** The puller's accepted vector. The endpoint sends what lies beyond it. */
  readonly vector: VersionVector;
  readonly support: Support;
  /** `0` is a pure vector exchange (verification step, design 8.2). */
  readonly limit: number;
  readonly origins?: readonly ReplicaId[];
}

export interface PullResponse {
  readonly endpointId: ReplicaId;
  /** The endpoint's own durable (accepted) vector. */
  readonly durable: VersionVector;
  readonly support: Support | '*';
  /** Canonical op lines, one origin after another, ascending `seq` per origin. */
  readonly ops: readonly string[];
  readonly blocked: readonly BlockedOrigin[];
  readonly more: boolean;
}

export interface PushRequest {
  readonly replicaId: ReplicaId;
  readonly support: Support;
  /** Canonical op lines. The sync engine always sends ops of ONE origin per request. */
  readonly ops: readonly string[];
}

export interface PushResponse {
  /** The endpoint's own durable vector after handling the request. */
  readonly durable: VersionVector;
  readonly rejected: readonly Rejection[];
  /** origin to the first missing `seq` (a gap reported by the endpoint). */
  readonly need: Readonly<Record<ReplicaId, number>>;
  readonly blocked: readonly BlockedOrigin[];
}

export interface AckRequest {
  readonly replicaId: ReplicaId;
  /** The requester's own durable accepted vector, sent after it committed what it received. */
  readonly durable: VersionVector;
}

/** One protocol for relays and replicas (design 8.1). */
export interface SyncEndpoint {
  pull(request: PullRequest): Promise<PullResponse>;
  push(request: PushRequest): Promise<PushResponse>;
  ack(request: AckRequest): Promise<void>;
}

export interface SyncCounts {
  readonly rounds: number;
  readonly pulled: number;
  readonly pushed: number;
  readonly duplicates: number;
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
        readonly status: 'complete';
        /** The common vector at the verified sync point (E == L_start == L_end). */
        readonly settled: VersionVector;
        readonly blocked: readonly [];
        readonly rejectedOrigins: readonly [];
      }
    | {
        readonly status: 'partial';
        readonly code: 'PEER_SCHEMA_OLDER';
        readonly blocked: readonly [BlockedOrigin, ...BlockedOrigin[]];
        readonly rejectedOrigins: readonly [];
      }
    | {
        readonly status: 'partial';
        readonly code: 'NOT_SETTLED';
        readonly blocked: readonly [];
        readonly rejectedOrigins: readonly [];
        readonly endpoint: VersionVector;
        readonly local: VersionVector;
      }
    | {
        readonly status: 'failed';
        readonly code: ErrorCode;
        readonly error: WeaveError;
        readonly blocked: readonly BlockedOrigin[];
        readonly rejectedOrigins: readonly RejectedOrigin[];
      }
  );

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
  /** origin to the first missing `seq` (gap reported to the sender). */
  readonly need: Readonly<Record<ReplicaId, number>>;
  readonly blocked: readonly BlockedOrigin[];
  readonly duplicates: number;
  /** Buffered ops that were promoted into the accepted log by this batch. */
  readonly promoted: number;
  /** Number of ops newly accepted, including promotions. */
  readonly applied: number;
}

/** Applies a batch of canonical op lines. All-or-nothing for ordinary failures (design 7.3). */
export type ApplyIncoming = (lines: readonly string[], peerId: ReplicaId) => Promise<ApplyResult>;
