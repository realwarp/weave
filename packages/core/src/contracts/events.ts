import type { ErrorCode } from './errors.js';
import type { OpId, ReplicaId } from './json.js';

/**
 * Structured diagnostics (R12.1). Events carry IDs and counts, never field values (design 11).
 * Every variant has a `type` that names it.
 */
export type WeaveEvent =
  /** A sync run started. */
  | {
      /** Event name. */
      readonly type: 'sync.start';
      /** The peer being synced with, or `null` when it is not known yet. */
      readonly peer: ReplicaId | null;
    }
  /** A batch of ops of one origin was pushed to a peer. */
  | {
      /** Event name. */
      readonly type: 'batch.sent';
      /** The peer the batch was sent to. */
      readonly peer: ReplicaId;
      /** The replica that originally created the ops. */
      readonly origin: ReplicaId;
      /** Number of ops in the batch. */
      readonly count: number;
    }
  /** A batch of ops was pulled from a peer. */
  | {
      /** Event name. */
      readonly type: 'batch.received';
      /** The peer the batch came from. */
      readonly peer: ReplicaId;
      /** Number of ops in the batch. */
      readonly count: number;
    }
  /** An op was accepted into the replica's op log. */
  | {
      /** Event name. */
      readonly type: 'op.applied';
      /** The accepted op. */
      readonly opId: OpId;
      /** Where the op came from: a local write, an incoming sync, or promotion from the pending buffer. */
      readonly source: 'local' | 'sync' | 'promotion';
    }
  /** An op arrived that the replica already held (a duplicate; nothing changed). */
  | {
      /** Event name. */
      readonly type: 'op.duplicate';
      /** The duplicate op. */
      readonly opId: OpId;
    }
  /** An op arrived after a gap in its origin's sequence and was put in the pending buffer. */
  | {
      /** Event name. */
      readonly type: 'op.buffered';
      /** The buffered op. */
      readonly opId: OpId;
      /** The first missing `seq` of that origin. */
      readonly need: number;
    }
  /** A conflict was announced for the first time (at most once per conflict, D8). */
  | {
      /** Event name. */
      readonly type: 'conflict.new';
      /** The conflict's ID (see `ConflictRecord.conflictId`). */
      readonly conflictId: string;
      /** `superseded` when a later op already resolved it, for example within the same batch. */
      readonly status: 'open' | 'superseded';
    }
  /** A retryable failure; the sync engine waits and tries again. */
  | {
      /** Event name. */
      readonly type: 'retry';
      /** The retry number, starting at 1. */
      readonly attempt: number;
      /** How long the engine waits before the retry, in milliseconds. */
      readonly delayMs: number;
      /** The error code of the failure being retried. */
      readonly code: ErrorCode;
    }
  /** A failure: a rejected origin, a dropped damaged buffer entry, an identity conflict, a failed sync. */
  | {
      /** Event name. */
      readonly type: 'error';
      /** The error code. */
      readonly code: ErrorCode;
      /** A human-readable description, without field values. */
      readonly message: string;
      /** The op involved, when there is one. */
      readonly opId?: OpId;
    }
  /** Opening a file journal cut off an interrupted final append (design 9.1). */
  | {
      /** Event name. */
      readonly type: 'open.truncated';
      /** Number of bytes removed from the end of the journal. */
      readonly bytes: number;
    };

/** A logger receives every event. When none is configured nothing is logged (R12.2). */
export type Logger = (event: WeaveEvent) => void;
