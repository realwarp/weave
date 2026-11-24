/**
 * Relay HTTP server (R4a.1, R4a.9, design 10.1). Node `http` only.
 *
 *   POST /v1/pull  JSON -> NDJSON     POST /v1/push  NDJSON -> JSON
 *   POST /v1/ack   JSON -> 204        GET  /v1/health        -> JSON
 *   [ADV] GET /v1/snapshot -> JSON    PUT  /v1/snapshot JSON -> 204
 *   [ADV] POST /v1/admin/compact      POST /v1/admin/remove-peer
 *
 * An optional bearer token is compared in constant time and never logged.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  REPLICA_ID_PATTERN,
  WeaveError,
  isWeaveError,
  systemScheduler,
  type AckRequest,
  type PullRequest,
  type Scheduler,
  type Snapshot,
  type Support,
  type VersionVector,
} from '@weave/core/protocol';
import { decodePushRequest, encodePullResponse } from '@weave/transport/http';
import type { RelayCore } from '../core/index.js';
import { DEFAULT_MAX_SNAPSHOT_BYTES } from '../core/snapshot.js';

export interface RelayServerOptions {
  readonly core: RelayCore;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** Maximum request body size (default 4 MiB). */
  readonly maxBodyBytes?: number;
  /** [ADV] Maximum snapshot upload size for `PUT /v1/snapshot` (default 64 MiB). */
  readonly maxSnapshotBytes?: number;
  /** Receives one line per request without secrets. */
  readonly log?: (line: string) => void;
  /** Monotonic time source for request durations in the log (default: platform). */
  readonly scheduler?: Scheduler;
}

export interface RunningRelay {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  const actual = Buffer.from(header ?? '', 'utf8');
  if (actual.length !== expected.length) {
    timingSafeEqual(expected, expected); // keep timing similar
    return false;
  }
  return timingSafeEqual(actual, expected);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (!isObject(parsed)) throw new SyntaxError('body must be a JSON object');
  return parsed;
}

function invalid(message: string): WeaveError {
  return new WeaveError('VALIDATION_FAILED', message);
}

const isCount = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function replicaId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !REPLICA_ID_PATTERN.test(v))
    throw invalid(`${what} must be a replica ID`);
  return v;
}

function vector(v: unknown, what: string): VersionVector {
  if (!isObject(v)) throw invalid(`${what} must be an object`);
  for (const [id, seq] of Object.entries(v)) {
    replicaId(id, `${what} key`);
    if (!isCount(seq, 0)) throw invalid(`${what} values must be non-negative integers`);
  }
  return v as VersionVector;
}

function support(v: unknown): Support {
  if (!isObject(v)) throw invalid('support must be an object');
  for (const version of Object.values(v)) {
    if (!isCount(version, 1)) throw invalid('support values must be positive integers');
  }
  return v as Support;
}

/** Checks a pull body field by field, so nothing malformed reaches storage (R16.1). */
function pullRequest(body: Record<string, unknown>): PullRequest {
  if (!isCount(body['limit'], 0)) throw invalid('limit must be a non-negative integer');
  const origins = body['origins'];
  if (
    origins !== undefined &&
    (!Array.isArray(origins) || origins.some((o) => typeof o !== 'string'))
  ) {
    throw invalid('origins must be an array of replica IDs');
  }
  // [ADV] R8.7: a puller that holds unreadable ops asks for every op.
  const hold = body['hold'];
  if (hold !== undefined && typeof hold !== 'boolean') throw invalid('hold must be a boolean');
  return {
    replicaId: replicaId(body['replicaId'], 'replicaId'),
    vector: vector(body['vector'], 'vector'),
    support: support(body['support']),
    limit: body['limit'],
    ...(origins === undefined
      ? {}
      : { origins: (origins as unknown[]).map((o) => replicaId(o, 'origins entry')) }),
    ...(hold === true ? { hold: true } : {}),
  };
}

function ackRequest(body: Record<string, unknown>): AckRequest {
  return {
    replicaId: replicaId(body['replicaId'], 'replicaId'),
    durable: vector(body['durable'], 'durable'),
  };
}

export function createRelayServer(options: RelayServerOptions): Server {
  const max = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const maxSnapshot = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const log = options.log ?? (() => undefined);
  const scheduler = options.scheduler ?? systemScheduler;
  return createServer((req, res) => {
    void (async () => {
      const route = `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]}`;
      const started = scheduler.monotonicMs();
      let status = 500;
      try {
        if (route === 'GET /v1/health') {
          status = 200;
          return send(res, 200, JSON.stringify({ ok: true, endpointId: options.core.endpointId }));
        }
        if (
          options.token !== undefined &&
          !tokenMatches(req.headers.authorization, options.token)
        ) {
          status = 401;
          return send(res, 401, JSON.stringify({ message: 'A valid bearer token is required' }));
        }
        if (route === 'GET /v1/snapshot') {
          const s = await options.core.snapshot();
          status = 200;
          return send(res, 200, JSON.stringify(s));
        }
        const isSnapshotUpload = route === 'PUT /v1/snapshot';
        const body = await readBody(req, isSnapshotUpload ? maxSnapshot : max);
        if (isSnapshotUpload) {
          await options.core.putSnapshot(parseJson(body) as unknown as Snapshot);
          status = 204;
          res.writeHead(204);
          return res.end();
        }
        if (route === 'POST /v1/pull') {
          const r = await options.core.pull(pullRequest(parseJson(body)));
          status = 200;
          return send(res, 200, encodePullResponse(r), 'application/x-ndjson');
        }
        if (route === 'POST /v1/push') {
          const request = decodePushRequest(body);
          replicaId(request.replicaId, 'replicaId');
          support(request.support);
          const r = await options.core.push(request);
          status = 200;
          return send(res, 200, JSON.stringify(r));
        }
        if (route === 'POST /v1/ack') {
          await options.core.ack(ackRequest(parseJson(body)));
          status = 204;
          res.writeHead(204);
          return res.end();
        }
        if (route === 'POST /v1/admin/compact') {
          const result = await options.core.compact();
          status = 200;
          return send(res, 200, JSON.stringify(result));
        }
        if (route === 'POST /v1/admin/remove-peer') {
          const parsed = parseJson(body);
          const replicaIdValue = replicaId(parsed['replicaId'], 'replicaId');
          await options.core.removePeer(replicaIdValue);
          status = 204;
          res.writeHead(204);
          return res.end();
        }
        status = 404;
        return send(res, 404, JSON.stringify({ message: 'Not found' }));
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          status = 413;
          return send(res, 413, JSON.stringify({ message: `The body exceeds ${max} bytes` }));
        }
        if (e instanceof SyntaxError) {
          status = 400;
          return send(
            res,
            400,
            JSON.stringify({ code: 'VALIDATION_FAILED', message: 'Malformed request body' }),
          );
        }
        if (isWeaveError(e)) {
          const retryable = e.code === 'STORAGE_CONFLICT' || e.code === 'STORAGE_ERROR';
          // Map NEEDS_SNAPSHOT and PEER_REMOVED to HTTP 409
          if (e.code === 'NEEDS_SNAPSHOT' || e.code === 'PEER_REMOVED') {
            status = 409;
            return send(
              res,
              status,
              JSON.stringify({ code: e.code, message: e.message, details: e.details }),
            );
          }
          status = retryable ? 503 : 400;
          return send(
            res,
            status,
            JSON.stringify({ code: e.code, message: e.message, details: e.details }),
          );
        }
        status = 500;
        return send(res, 500, JSON.stringify({ message: 'Internal error' }));
      } finally {
        log(`${route} ${status} ${Math.round(scheduler.monotonicMs() - started)}ms`);
      }
    })();
  });
}

/** Starts listening; binds to 127.0.0.1 unless another host is given. */
export async function listen(
  server: Server,
  port: number,
  host = '127.0.0.1',
): Promise<RunningRelay> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
