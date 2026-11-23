import type { ErrorCode } from './errors.js';
import type { OpId, ReplicaId } from './json.js';

/** Structured diagnostics (R12.1). Events carry IDs and counts, never field values (design 11). */
export type WeaveEvent =
  | { readonly type: 'sync.start'; readonly peer: ReplicaId | null }
  | {
      readonly type: 'batch.sent';
      readonly peer: ReplicaId;
      readonly origin: ReplicaId;
      readonly count: number;
    }
  | { readonly type: 'batch.received'; readonly peer: ReplicaId; readonly count: number }
  | {
      readonly type: 'op.applied';
      readonly opId: OpId;
      readonly source: 'local' | 'sync' | 'promotion';
    }
  | { readonly type: 'op.duplicate'; readonly opId: OpId }
  | { readonly type: 'op.buffered'; readonly opId: OpId; readonly need: number }
  | {
      readonly type: 'conflict.new';
      readonly conflictId: string;
      readonly status: 'open' | 'superseded';
    }
  | {
      readonly type: 'retry';
      readonly attempt: number;
      readonly delayMs: number;
      readonly code: ErrorCode;
    }
  | {
      readonly type: 'error';
      readonly code: ErrorCode;
      readonly message: string;
      readonly opId?: OpId;
    }
  | { readonly type: 'open.truncated'; readonly bytes: number };

/** A logger receives every event. When none is configured nothing is logged (R12.2). */
export type Logger = (event: WeaveEvent) => void;
