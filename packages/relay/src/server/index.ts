/**
 * Relay HTTP server (R4a.1, R4a.9, design 10.1). Node `http` only.
 *
 *   POST /v1/pull  JSON -> NDJSON     POST /v1/push  NDJSON -> JSON
 *   POST /v1/ack   JSON -> 204        GET  /v1/health        -> JSON
 *
 * An optional bearer token is compared in constant time and never logged.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isWeaveError,
  systemScheduler,
  type AckRequest,
  type PullRequest,
  type Scheduler,
} from '@weave/core/protocol';
import { decodePushRequest, encodePullResponse } from '@weave/transport/http';
import type { RelayCore } from '../core/index.js';

export interface RelayServerOptions {
  readonly core: RelayCore;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** Maximum request body size (default 4 MiB). */
  readonly maxBodyBytes?: number;
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

export function createRelayServer(options: RelayServerOptions): Server {
  const max = options.maxBodyBytes ?? 4 * 1024 * 1024;
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
        const body = await readBody(req, max);
        if (route === 'POST /v1/pull') {
          const r = await options.core.pull(parseJson(body) as unknown as PullRequest);
          status = 200;
          return send(res, 200, encodePullResponse(r), 'application/x-ndjson');
        }
        if (route === 'POST /v1/push') {
          const r = await options.core.push(decodePushRequest(body));
          status = 200;
          return send(res, 200, JSON.stringify(r));
        }
        if (route === 'POST /v1/ack') {
          await options.core.ack(parseJson(body) as unknown as AckRequest);
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
