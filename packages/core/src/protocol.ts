/**
 * `@weave/core/protocol`: wire types, the `SyncEndpoint` interface and the semantically opaque
 * helpers that the relay, the transport package and adapter authors need: op-line verification
 * (structure, value rules, canonical form, hash), envelope reading, prefix selection, version
 * vectors and identifiers. Nothing here knows about application schemas, resolvers or migrations.
 */
export type {
  AckRequest,
  ApplyIncoming,
  ApplyResult,
  BlockedOrigin,
  CompactionInfo,
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
export type { Clock, Random, Scheduler } from './contracts/env.js';
export type { Logger, WeaveEvent } from './contracts/events.js';
export type {
  MetaCompaction,
  MetaReplica,
  StorageAdapter,
  StorageTx,
} from './contracts/storage.js';
export { keys, padSeq } from './contracts/storage.js';
export { WeaveError, isWeaveError, ERROR_CODES } from './contracts/errors.js';
export type { ErrorCode, WeaveErrorOptions } from './contracts/errors.js';

export { compareUtf8, encodeCanonical, sha256Hex, toCanonical } from './canonical/index.js';
export {
  DEFAULT_MAX_OP_BYTES,
  REPLICA_ID_PATTERN,
  buildOp,
  mergeVectors,
  minVectors,
  newReplicaId,
  normalizeVector,
  platformRandom,
  randomFloat,
  readEnvelope,
  serializeOp,
  systemClock,
  systemScheduler,
  vectorDifference,
  vectorsEqual,
  verifyOpLine,
} from './ops/index.js';
export {
  isSupported,
  selectFromLoaded,
  selectReadablePrefix,
  type OpEnvelope,
  type ReadOrigin,
  type SelectInput,
  type SelectOutput,
} from './sync/select.js';
