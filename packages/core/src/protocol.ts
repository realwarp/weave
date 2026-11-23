/**
 * `@weave/core/protocol`: wire types and the `SyncEndpoint` interface. Used by the relay, the
 * transport package and adapter authors. Implementation of op verification is added in T1.A3.
 */
export type {
  AckRequest,
  ApplyIncoming,
  ApplyResult,
  BlockedOrigin,
  PeerEntry,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  Rejection,
  RejectedOrigin,
  Support,
  SyncCounts,
  SyncEndpoint,
  SyncOptions,
  SyncResult,
} from './contracts/sync.js';
export type { Op, OpPayload } from './contracts/op.js';
export type { JsonValue, OpId, ReplicaId, VersionVector } from './contracts/json.js';
export type { StorageAdapter, StorageTx } from './contracts/storage.js';
export { keys, padSeq } from './contracts/storage.js';
export { WeaveError, isWeaveError, ERROR_CODES } from './contracts/errors.js';
export type { ErrorCode } from './contracts/errors.js';
