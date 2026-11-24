/// <reference types="node" />
/**
 * [ADV] WebSocket server for direct network sync (task T5.8, R4.4, R9.5). Node only. It serves any
 * `SyncEndpoint` (usually `replica.endpoint()`) over WebSocket, so two replicas sync directly
 * over the network with the same protocol as a relay. RFC 6455 is implemented here on
 * `node:http` upgrade with `node:crypto`; there is no runtime dependency.
 *
 * Security:
 * - Binds to 127.0.0.1 unless another host is given. Put TLS (`wss://`) in front across networks.
 * - A shared `token` only opens the endpoint (no identity), as on the relay. `authenticate` maps a
 *   bearer secret to a trusted `AuthContext`; the endpoint is then bound to it with
 *   `endpoint(auth)` (for example `(auth) => replica.endpoint({ auth })`), never from a request.
 * - Every request is checked field by field before it reaches the endpoint (R16.1). Frames must be
 *   masked, text only, at most `maxMessageBytes` per message. Secrets are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  REPLICA_ID_PATTERN,
  WeaveError,
  type AuthContext,
  type Snapshot,
  type SyncEndpoint,
} from '@weave/core/protocol';
import { CLOSE, FrameError, FrameParser, MessageAssembler, OPCODE, encodeFrame } from './frame.js';
import {
  BEARER_PREFIX,
  DEFAULT_PATH,
  SUBPROTOCOL,
  decodeBearer,
  parseRequest,
  toRpcError,
  type RpcRequest,
} from './rpc.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 64;

/** Options of `serveWebSocket`. */
export interface WebSocketServeOptions {
  /**
   * The endpoint to serve, or a function that returns the endpoint bound to the authenticated
   * caller (needed with `authenticate`, so the identity reaches the endpoint).
   */
  readonly endpoint: SyncEndpoint | ((auth: AuthContext | undefined) => SyncEndpoint);
  /** A shared secret that every connection must present. It gives no identity. */
  readonly token?: string;
  /**
   * Maps the presented secret (or `undefined`) to the caller's identity: an `AuthContext`, `null`
   * for "allowed, no identity", or `undefined` to refuse the connection (HTTP 401).
   */
  readonly authenticate?: (secret: string | undefined) => AuthContext | null | undefined;
  /** URL path (default `/v1/ws`). */
  readonly path?: string;
  /** Largest accepted message in bytes (default 16 MiB). */
  readonly maxMessageBytes?: number;
  /** Interface to bind (default 127.0.0.1). */
  readonly host?: string;
  /** Port (default 0: any free port). */
  readonly port?: number;
  /** Receives one line per connection event, without secrets. */
  readonly log?: (line: string) => void;
}

/** A running WebSocket endpoint. */
export interface RunningWebSocketEndpoint {
  /** The `ws://` URL to give to `websocketTransport`. */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** The underlying HTTP server. */
  readonly server: Server;
  /** Closes every connection (1001) and the server. */
  close(): Promise<void>;
}

function secretMatches(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

const invalid = (message: string): WeaveError => new WeaveError('VALIDATION_FAILED', message);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function replicaId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !REPLICA_ID_PATTERN.test(v))
    throw invalid(`${what} must be a replica ID`);
  return v;
}
function vector(v: unknown, what: string): Record<string, number> {
  if (!isObject(v)) throw invalid(`${what} must be an object`);
  for (const [id, seq] of Object.entries(v)) {
    replicaId(id, `${what} key`);
    if (!isCount(seq, 0)) throw invalid(`${what} values must be non-negative integers`);
  }
  return v as Record<string, number>;
}
function support(v: unknown): Record<string, number> {
  if (!isObject(v)) throw invalid('support must be an object');
  for (const n of Object.values(v))
    if (!isCount(n, 1)) throw invalid('support values must be positive integers');
  return v as Record<string, number>;
}

/** Checks one request's params field by field, so nothing malformed reaches the endpoint. */
export function checkParams(req: RpcRequest): unknown {
  const p = req.params;
  switch (req.method) {
    case 'pull': {
      if (!isObject(p)) throw invalid('pull params must be an object');
      if (!isCount(p['limit'], 0)) throw invalid('limit must be a non-negative integer');
      const origins = p['origins'];
      if (origins !== undefined && !Array.isArray(origins)) throw invalid('origins must be a list');
      const hold = p['hold'];
      if (hold !== undefined && typeof hold !== 'boolean') throw invalid('hold must be a boolean');
      return {
        replicaId: replicaId(p['replicaId'], 'replicaId'),
        vector: vector(p['vector'], 'vector'),
        support: support(p['support']),
        limit: p['limit'],
        ...(origins === undefined
          ? {}
          : { origins: (origins as unknown[]).map((o) => replicaId(o, 'origins entry')) }),
        ...(hold === true ? { hold: true } : {}),
      };
    }
    case 'push': {
      if (!isObject(p)) throw invalid('push params must be an object');
      const ops = p['ops'];
      if (!Array.isArray(ops) || ops.some((l) => typeof l !== 'string'))
        throw invalid('ops must be a list of op lines');
      return {
        replicaId: replicaId(p['replicaId'], 'replicaId'),
        support: support(p['support']),
        ops,
      };
    }
    case 'ack':
      if (!isObject(p)) throw invalid('ack params must be an object');
      return {
        replicaId: replicaId(p['replicaId'], 'replicaId'),
        durable: vector(p['durable'], 'durable'),
      };
    case 'snapshot':
      return undefined;
    case 'putSnapshot':
      if (!isObject(p)) throw invalid('putSnapshot params must be a snapshot object');
      return p; // verified in full by the endpoint (hash, every op line, vectors)
  }
}

async function dispatch(endpoint: SyncEndpoint, req: RpcRequest): Promise<unknown> {
  const params = checkParams(req);
  switch (req.method) {
    case 'pull':
      return endpoint.pull(params as Parameters<SyncEndpoint['pull']>[0]);
    case 'push':
      return endpoint.push(params as Parameters<SyncEndpoint['push']>[0]);
    case 'ack':
      await endpoint.ack(params as Parameters<SyncEndpoint['ack']>[0]);
      return undefined;
    case 'snapshot':
      if (endpoint.snapshot === undefined)
        throw new WeaveError('NOT_SUPPORTED', 'This endpoint does not serve snapshots');
      return endpoint.snapshot();
    case 'putSnapshot':
      if (endpoint.putSnapshot === undefined)
        throw new WeaveError('NOT_SUPPORTED', 'This endpoint does not store snapshots');
      await endpoint.putSnapshot(params as Snapshot);
      return undefined;
  }
}

/** The id of a request that failed to parse, when it has a usable one. */
function idOf(text: string): number | undefined {
  try {
    const v = JSON.parse(text) as { id?: unknown };
    return Number.isSafeInteger(v.id) && (v.id as number) >= 1 ? (v.id as number) : undefined;
  } catch {
    return undefined;
  }
}

function refuse(socket: Socket, status: number, reason: string, extra = ''): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`,
  );
}

/**
 * Serves `options.endpoint` over WebSocket.
 * @returns The running endpoint with its `ws://` URL.
 * @throws VALIDATION_FAILED when `authenticate` is given with a plain endpoint (the identity could
 *   not reach it) or when an option is invalid.
 */
export async function serveWebSocket(
  options: WebSocketServeOptions,
): Promise<RunningWebSocketEndpoint> {
  const path = options.path ?? DEFAULT_PATH;
  const maxMessage = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  const log = options.log ?? (() => undefined);
  if (!isCount(maxMessage, 1)) throw invalid('maxMessageBytes must be a positive integer');
  if (options.token !== undefined && options.token.length === 0)
    throw invalid('token must not be empty');
  if (options.authenticate !== undefined && typeof options.endpoint !== 'function')
    throw invalid('With authenticate, endpoint must be a function of the identity');
  const endpointFor = (auth: AuthContext | undefined): SyncEndpoint =>
    typeof options.endpoint === 'function' ? options.endpoint(auth) : options.endpoint;

  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(426, { upgrade: 'websocket', 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url !== path) return refuse(socket, 404, 'Not Found');
    if (req.method !== 'GET') return refuse(socket, 405, 'Method Not Allowed');
    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket')
      return refuse(socket, 400, 'Bad Request');
    if (req.headers['sec-websocket-version'] !== '13')
      return refuse(socket, 426, 'Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16)
      return refuse(socket, 400, 'Bad Request');
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!offered.includes(SUBPROTOCOL)) return refuse(socket, 400, 'Bad Request');

    // The secret: a subprotocol bearer entry (browsers), or an Authorization header (Node).
    const bearer = offered.find((s) => s.startsWith(BEARER_PREFIX));
    const header = req.headers.authorization;
    const secret =
      bearer !== undefined
        ? decodeBearer(bearer)
        : typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice(7)
          : undefined;
    let auth: AuthContext | null | undefined;
    if (options.authenticate !== undefined) auth = options.authenticate(secret);
    else if (options.token !== undefined)
      auth = secretMatches(secret, options.token) ? null : undefined;
    else auth = null;
    if (auth === undefined) {
      log('ws refused 401');
      return refuse(socket, 401, 'Unauthorized');
    }

    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    log('ws open');
    serveConnection(socket, endpointFor(auth ?? undefined), maxMessage, () => {
      sockets.delete(socket);
      log('ws closed');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host =
    options.host === undefined || options.host === '0.0.0.0' ? '127.0.0.1' : options.host;
  return {
    url: `ws://${host}:${address.port}${path}`,
    port: address.port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          if (s.writable) s.write(encodeFrame(OPCODE.close, closePayload(CLOSE.goingAway)));
          s.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

function closePayload(code: number): Uint8Array {
  return new Uint8Array([(code >>> 8) & 0xff, code & 0xff]);
}

function serveConnection(
  socket: Socket,
  endpoint: SyncEndpoint,
  maxMessage: number,
  onEnd: () => void,
): void {
  const parser = new FrameParser({ maxPayload: maxMessage, requireMask: true });
  const assembler = new MessageAssembler(maxMessage);
  let inFlight = 0;
  let closing = false;
  const encoder = new TextEncoder();

  const send = (opcode: number, payload: Uint8Array): void => {
    if (socket.writable && !closing) socket.write(encodeFrame(opcode, payload));
  };
  const sendText = (value: unknown): void =>
    send(OPCODE.text, encoder.encode(JSON.stringify(value)));
  const fail = (code: number): void => {
    if (socket.writable && !closing) socket.write(encodeFrame(OPCODE.close, closePayload(code)));
    closing = true;
    socket.end();
  };

  const handle = (text: string): void => {
    let req: RpcRequest;
    try {
      req = parseRequest(text);
    } catch (e) {
      const id = idOf(text);
      if (id === undefined) return fail(CLOSE.policy);
      return sendText({ id, error: toRpcError(e) });
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      sendText({
        id: req.id,
        error: { code: 'TRANSPORT_ERROR', message: 'Too many requests in flight', retryable: true },
      });
      return;
    }
    inFlight++;
    void dispatch(endpoint, req)
      .then(
        (result) => sendText(result === undefined ? { id: req.id } : { id: req.id, result }),
        (e: unknown) => sendText({ id: req.id, error: toRpcError(e) }),
      )
      .finally(() => {
        inFlight--;
      });
  };

  socket.on('data', (chunk: Buffer) => {
    if (closing) return;
    try {
      for (const frame of parser.push(new Uint8Array(chunk))) {
        if (frame.opcode === OPCODE.ping) send(OPCODE.pong, frame.payload);
        else if (frame.opcode === OPCODE.pong) continue;
        else if (frame.opcode === OPCODE.close) {
          const code =
            frame.payload.length >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : CLOSE.normal;
          fail(code >= 1000 && code < 5000 ? code : CLOSE.protocolError);
          return;
        } else {
          const text = assembler.add(frame);
          if (text !== undefined) handle(text);
        }
      }
    } catch (e) {
      fail(e instanceof FrameError ? e.code : CLOSE.protocolError);
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', onEnd);
}
