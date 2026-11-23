/**
 * HTTP client transport: the client of the WEAVE relay (design 10.1, R9.2).
 *
 *   POST /v1/pull  JSON {replicaId, vector, support, limit, origins?}  -> NDJSON pull response
 *   POST /v1/push  NDJSON {replicaId, support} + op lines             -> JSON {durable, rejected, need, blocked}
 *   POST /v1/ack   JSON {replicaId, durable}                           -> 204
 *
 * Error mapping (R10.2): network failures, timeouts, HTTP 5xx and 429 are retryable
 * TRANSPORT_ERRORs. Other 4xx responses are not retryable; a JSON body `{code}` naming a WEAVE
 * error code becomes that WeaveError.
 */
import {
  ERROR_CODES,
  WeaveError,
  type AckRequest,
  type ErrorCode,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncEndpoint,
} from '@weave/core/protocol';
import { decodePullResponse, encodePushRequest } from './ndjson.js';

export {
  decodePullResponse,
  decodePushRequest,
  encodePullResponse,
  encodePushRequest,
} from './ndjson.js';

/** HTTP transport options for the relay client. */
export interface HttpTransportOptions {
  /** Base URL of the relay, for example `http://127.0.0.1:8787`. */
  readonly baseUrl: string;
  /** Bearer token for authentication, when the relay requires one. */
  readonly token?: string;
  /** Custom fetch implementation for testing. */
  readonly fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30000). */
  readonly timeoutMs?: number;
}

function transportError(
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
  cause?: unknown,
): WeaveError {
  return new WeaveError('TRANSPORT_ERROR', message, { retryable, details, cause });
}

async function errorFromResponse(response: Response): Promise<WeaveError> {
  const status = response.status;
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  if (status >= 500 || status === 429)
    return transportError(`Relay answered HTTP ${status}`, true, { status });
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown; details?: unknown };
    if (
      typeof parsed.code === 'string' &&
      (ERROR_CODES as readonly string[]).includes(parsed.code)
    ) {
      return new WeaveError(
        parsed.code as ErrorCode,
        typeof parsed.message === 'string' ? parsed.message : `Relay error ${parsed.code}`,
        {
          details: {
            status,
            ...(typeof parsed.details === 'object' && parsed.details !== null
              ? (parsed.details as Record<string, unknown>)
              : {}),
          },
        },
      );
    }
  } catch {
    // not JSON
  }
  return transportError(`Relay answered HTTP ${status}`, false, { status });
}

/**
 * Creates an HTTP transport that calls the WEAVE relay (design 10.1).
 * @param options - Transport configuration including base URL and optional authentication.
 * @returns A SyncEndpoint implementation using HTTP requests.
 */
export function httpTransport(options: HttpTransportOptions): SyncEndpoint {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function call(route: string, body: string, contentType: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { 'content-type': contentType };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await doFetch(`${base}${route}`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      const timedOut = controller.signal.aborted;
      throw transportError(
        timedOut ? `Request to ${route} timed out` : `Request to ${route} failed`,
        true,
        { route },
        e,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  async function readText(response: Response, route: string): Promise<string> {
    try {
      return await response.text();
    } catch (e) {
      throw transportError(`Reading the response of ${route} failed`, true, { route }, e);
    }
  }

  return {
    /**
     * Pulls ops from the relay for a given replica and vector.
     * @param request - The pull request containing replica ID, vector, support, limit, and optional origins.
     * @returns The pull response with ops and metadata.
     */
    async pull(request: PullRequest): Promise<PullResponse> {
      const response = await call('/v1/pull', JSON.stringify(request), 'application/json');
      return decodePullResponse(await readText(response, '/v1/pull'));
    },
    /**
     * Pushes ops to the relay.
     * @param request - The push request containing replica ID, support, and ops.
     * @returns The push response with durable acks, rejected ops, and other metadata.
     */
    async push(request: PushRequest): Promise<PushResponse> {
      const response = await call('/v1/push', encodePushRequest(request), 'application/x-ndjson');
      const text = await readText(response, '/v1/push');
      try {
        return JSON.parse(text) as PushResponse;
      } catch (e) {
        throw transportError('The push response is not JSON', true, {}, e);
      }
    },
    /**
     * Acknowledges durable ops to the relay.
     * @param request - The acknowledgment request containing replica ID and durable vector.
     */
    async ack(request: AckRequest): Promise<void> {
      const response = await call('/v1/ack', JSON.stringify(request), 'application/json');
      await readText(response, '/v1/ack');
    },
  };
}
