/** Stable error codes (R10.1). `PEER_SCHEMA_OLDER` and `NOT_SETTLED` are sync-result codes, not errors. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNSUPPORTED_VALUE',
  'INTEGRITY_CONFLICT',
  'REPLICA_ID_REUSE',
  'MUTATION_ID_REUSED',
  'RECORD_DELETED',
  'MIGRATION_FAILED',
  'SCHEMA_TOO_NEW',
  'SCHEMA_DOWNGRADE',
  'NOT_SUPPORTED',
  'NEEDS_SNAPSHOT',
  'RESOLVER_ERROR',
  'TRANSPORT_ERROR',
  'STORAGE_ERROR',
  'STORAGE_CONFLICT',
  'STORAGE_CORRUPT',
  'STORAGE_LOCKED',
  'STORAGE_LOCK_LOST',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WeaveErrorOptions {
  /** Extra machine-readable context (for example the JSON path of an unsupported value). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Transport errors only: true when a retry may succeed (R10.2). */
  readonly retryable?: boolean;
}

/** The single error type thrown by WEAVE. Always carries a stable `code`. */
export class WeaveError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: WeaveErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WeaveError';
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }
}

export function isWeaveError(value: unknown): value is WeaveError {
  return value instanceof WeaveError;
}
