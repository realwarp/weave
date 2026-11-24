/**
 * [ADV] WebSocket client transport (task T5.8, R4.4, R9.5): a `SyncEndpoint` that talks to a
 * WEAVE WebSocket endpoint, for example a replica served with `serveWebSocket` from
 * `@weave/transport/websocket/server`. It uses the platform `WebSocket` (Node 22 and browsers),
 * so it has no runtime dependency and no Node import.
 *
 * - One connection, opened on first use and reused; several requests may be in flight.
 * - Error mapping (R10.2): a lost connection, a failed handshake and a timeout are retryable
 *   `TRANSPORT_ERROR`s; the next request opens a new connection. An error the endpoint returns
 *   keeps its WEAVE code (for example `INTEGRITY_CONFLICT`, `UNAUTHORIZED`).
 * - A bearer secret travels as a subprotocol entry (`weave.bearer.<base64url>`), because browsers
 *   cannot set headers on a WebSocket. Use `wss://` so it is encrypted.
 */
import {
  WeaveError,
  type AckRequest,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Snapshot,
  type SyncEndpoint,
} from '@weave/core/protocol';
import { SUBPROTOCOL, encodeBearer, fromRpcError, parseResponse, type Method } from './rpc.js';

export { DEFAULT_PATH, SUBPROTOCOL } from './rpc.js';

/** The part of the platform `WebSocket` this transport uses. */
export interface WebSocketLike {
  /** The connection state (0 connecting, 1 open, 2 closing, 3 closed). */
  readonly readyState: number;
  /** The subprotocol the server chose. */
  readonly protocol: string;
  /** Sends one text message. */
  send(data: string): void;
  /** Closes the connection. */
  close(code?: number, reason?: string): void;
  /** Registers a listener. */
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
}

/** Constructor of a `WebSocketLike` (the global `WebSocket` fits). */
export type WebSocketFactory = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** WebSocket transport options. */
export interface WebSocketTransportOptions {
  /** The endpoint URL, for example `ws://127.0.0.1:8788/v1/ws` (use `wss://` across networks). */
  readonly url: string;
  /** Bearer secret, when the endpoint requires one. */
  readonly token?: string;
  /** Per-request timeout in milliseconds (default 30000), including connecting. */
  readonly timeoutMs?: number;
  /** A `WebSocket` implementation (default: the global one). */
  readonly WebSocket?: WebSocketFactory;
}

/** A `WebSocketTransport` can also close its connection. */
export interface WebSocketTransport extends SyncEndpoint {
  /** Closes the connection; requests in flight fail with a retryable `TRANSPORT_ERROR`. */
  close(): void;
}

function transportError(message: string, details: Record<string, unknown> = {}): WeaveError {
  return new WeaveError('TRANSPORT_ERROR', message, { retryable: true, details });
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: WeaveError): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates a WebSocket transport.
 * @param options The endpoint URL and optional secret, timeout and `WebSocket` implementation.
 * @returns A `SyncEndpoint` over one reusable connection.
 */
export function websocketTransport(options: WebSocketTransportOptions): WebSocketTransport {
  const found = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketFactory }).WebSocket;
  if (found === undefined)
    throw new WeaveError('NOT_SUPPORTED', 'No WebSocket implementation is available');
  const Ctor: WebSocketFactory = found;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const protocols =
    options.token === undefined ? [SUBPROTOCOL] : [SUBPROTOCOL, encodeBearer(options.token)];
  let socket: WebSocketLike | undefined;
  let opening: Promise<WebSocketLike> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (error: WeaveError): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(error);
    }
  };

  function connect(): Promise<WebSocketLike> {
    if (socket !== undefined && socket.readyState === 1) return Promise.resolve(socket);
    if (opening !== undefined) return opening;
    opening = new Promise<WebSocketLike>((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = new Ctor(options.url, protocols);
      } catch (e) {
        opening = undefined;
        reject(
          transportError('Could not open the WebSocket', { url: options.url, cause: String(e) }),
        );
        return;
      }
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        opening = undefined;
        ws.close();
        reject(transportError('Opening the WebSocket timed out', { url: options.url }));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        opened = true;
        clearTimeout(timer);
        opening = undefined;
        if (ws.protocol !== SUBPROTOCOL) {
          ws.close(1002, 'subprotocol');
          reject(transportError('The endpoint does not speak weave.v1', { url: options.url }));
          return;
        }
        socket = ws;
        resolve(ws);
      });
      ws.addEventListener('message', (event) => {
        const data = (event as { data?: unknown }).data;
        const msg = typeof data === 'string' ? parseResponse(data) : undefined;
        if (msg === undefined) {
          ws.close(1002, 'bad response');
          return;
        }
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error !== undefined) p.reject(fromRpcError(msg.error));
        else p.resolve(msg.result);
      });
      const onEnd = (): void => {
        clearTimeout(timer);
        if (socket === ws) socket = undefined;
        if (!opened) {
          opening = undefined;
          // Browsers hide the reason of a failed handshake (for example HTTP 401).
          reject(transportError('The WebSocket handshake failed', { url: options.url }));
        }
        failAll(transportError('The WebSocket connection closed', { url: options.url }));
      };
      ws.addEventListener('close', onEnd);
      ws.addEventListener('error', onEnd);
    });
    return opening;
  }

  async function call<T>(method: Method, params?: unknown): Promise<T> {
    const ws = await connect();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(transportError(`The ${method} request timed out`, { method }));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(transportError(`Sending the ${method} request failed`, { method }));
      }
    });
  }

  return {
    pull: (request: PullRequest) => call<PullResponse>('pull', request),
    push: (request: PushRequest) => call<PushResponse>('push', request),
    ack: (request: AckRequest) => call<void>('ack', request).then(() => undefined),
    snapshot: () => call<Snapshot>('snapshot'),
    putSnapshot: (snapshot: Snapshot) => call<void>('putSnapshot', snapshot).then(() => undefined),
    close: () => {
      const ws = socket;
      socket = undefined;
      ws?.close(1000, 'done');
      failAll(transportError('The transport was closed'));
    },
  };
}
