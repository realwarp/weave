/**
 * [ADV] The WEAVE request and response messages over WebSocket (task T5.8). One JSON text message
 * per request and per response; requests carry an `id` that the response echoes, so several
 * requests may be in flight on one connection. Op lines travel as JSON strings, which keeps them
 * byte for byte (canonical lines contain no unpaired surrogates, D7).
 *
 *   request:  {"id": 1, "method": "pull", "params": <PullRequest>}
 *   response: {"id": 1, "result": <PullResponse>}
 *   error:    {"id": 1, "error": {"code": "INTEGRITY_CONFLICT", "message": "...", "retryable": false}}
 *
 * Methods: `pull`, `push`, `ack`, `snapshot`, `putSnapshot` (the `SyncEndpoint` methods).
 */
import { ERROR_CODES, WeaveError, type ErrorCode } from '@weave/core/protocol';

/** The WebSocket subprotocol both sides must agree on. */
export const SUBPROTOCOL = 'weave.v1';
/** Prefix of the subprotocol entry that carries a bearer secret (browsers cannot set headers). */
export const BEARER_PREFIX = 'weave.bearer.';
/** Default URL path of the endpoint. */
export const DEFAULT_PATH = '/v1/ws';

/** The endpoint methods a request may call. */
export const METHODS = ['pull', 'push', 'ack', 'snapshot', 'putSnapshot'] as const;
/** One of `METHODS`. */
export type Method = (typeof METHODS)[number];

/** A request message. */
export interface RpcRequest {
  /** Echoed by the response. A positive safe integer. */
  readonly id: number;
  /** The endpoint method. */
  readonly method: Method;
  /** The method's request object (absent for `snapshot`). */
  readonly params?: unknown;
}

/** The error part of a failed response. */
export interface RpcError {
  /** A stable WEAVE error code. */
  readonly code: string;
  /** A human-readable message. */
  readonly message: string;
  /** Whether a retry may succeed. */
  readonly retryable?: boolean;
  /** Machine-readable details. */
  readonly details?: Record<string, unknown>;
}

/** A response message. */
export interface RpcResponse {
  /** The request's `id`. */
  readonly id: number;
  /** The method's result (absent on error and for `ack`/`putSnapshot`). */
  readonly result?: unknown;
  /** Present when the request failed. */
  readonly error?: RpcError;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses a request; throws `VALIDATION_FAILED` for anything malformed. */
export function parseRequest(text: string): RpcRequest {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new WeaveError('VALIDATION_FAILED', 'The message is not JSON');
  }
  if (!isObject(v)) throw new WeaveError('VALIDATION_FAILED', 'The message must be an object');
  const id = v['id'];
  if (!Number.isSafeInteger(id) || (id as number) < 1)
    throw new WeaveError('VALIDATION_FAILED', 'id must be a positive integer');
  const method = v['method'];
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method))
    throw new WeaveError('VALIDATION_FAILED', `Unknown method`, { details: { id } });
  return { id: id as number, method: method as Method, params: v['params'] };
}

/** Parses a response; returns `undefined` for anything malformed (the client then closes). */
export function parseResponse(text: string): RpcResponse | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v) || !Number.isSafeInteger(v['id'])) return undefined;
  const error = v['error'];
  if (error !== undefined) {
    if (
      !isObject(error) ||
      typeof error['code'] !== 'string' ||
      typeof error['message'] !== 'string'
    )
      return undefined;
  }
  return v as unknown as RpcResponse;
}

/** The error payload for a thrown value. Never includes stacks or causes. */
export function toRpcError(e: unknown): RpcError {
  if (e instanceof WeaveError) {
    const retryable = e.retryable || e.code === 'STORAGE_CONFLICT' || e.code === 'STORAGE_ERROR';
    return {
      code: e.code,
      message: e.message,
      ...(retryable ? { retryable: true } : {}),
      ...(Object.keys(e.details).length === 0 ? {} : { details: { ...e.details } }),
    };
  }
  return { code: 'TRANSPORT_ERROR', message: 'Internal error', retryable: true };
}

/** The `WeaveError` for a received error payload. Unknown codes become TRANSPORT_ERROR. */
export function fromRpcError(error: RpcError): WeaveError {
  const known = (ERROR_CODES as readonly string[]).includes(error.code);
  return new WeaveError(known ? (error.code as ErrorCode) : 'TRANSPORT_ERROR', error.message, {
    retryable: error.retryable === true,
    details: { ...(error.details ?? {}), ...(known ? {} : { remoteCode: error.code }) },
  });
}

/** Encodes a bearer secret for the subprotocol list (base64url of its UTF-8 bytes). */
export function encodeBearer(secret: string): string {
  const bytes = new TextEncoder().encode(secret);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return BEARER_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a subprotocol bearer entry; `undefined` when it is not one or is malformed. */
export function decodeBearer(entry: string): string | undefined {
  if (!entry.startsWith(BEARER_PREFIX)) return undefined;
  const b64 = entry.slice(BEARER_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(b64)) return undefined;
  try {
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
