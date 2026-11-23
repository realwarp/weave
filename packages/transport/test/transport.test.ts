import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WeaveError, isWeaveError, type SyncEndpoint } from '@weave/core/protocol';
import {
  FaultyEndpoint,
  ReferenceEndpoint,
  makeOps,
  runTransportConformance,
} from '../../testing/src/transport/index.js';
import {
  decodePullResponse,
  decodePushRequest,
  encodePullResponse,
  encodePushRequest,
  httpTransport,
} from '../src/http/index.js';
import { inProcessTransport } from '../src/in-process/index.js';

/** A stub relay: the four HTTP routes on top of a ReferenceEndpoint. */
async function stubRelay(
  options: { token?: string; failNext?: () => number | undefined; delayMs?: number } = {},
) {
  const endpoint = new ReferenceEndpoint();
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => resolve(body));
    });
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (options.delayMs !== undefined) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
        return send(res, 401, JSON.stringify({ message: 'unauthorized' }));
      }
      const forced = options.failNext?.();
      if (forced !== undefined) return send(res, forced, 'error');
      const body = await read(req);
      try {
        if (req.url === '/v1/pull') {
          const out = await endpoint.pull(JSON.parse(body) as Parameters<SyncEndpoint['pull']>[0]);
          return send(res, 200, encodePullResponse(out), 'application/x-ndjson');
        }
        if (req.url === '/v1/push')
          return send(res, 200, JSON.stringify(await endpoint.push(decodePushRequest(body))));
        if (req.url === '/v1/ack') {
          await endpoint.ack(JSON.parse(body) as Parameters<SyncEndpoint['ack']>[0]);
          res.writeHead(204);
          return res.end();
        }
        return send(res, 404, '{}');
      } catch (e) {
        if (isWeaveError(e))
          return send(res, 400, JSON.stringify({ code: e.code, message: e.message }));
        return send(res, 500, 'internal');
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    endpoint,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

runTransportConformance('reference endpoint (direct)', async () => ({
  endpoint: new ReferenceEndpoint(),
}));
runTransportConformance('in-process transport', async () => ({
  endpoint: inProcessTransport(new ReferenceEndpoint()),
}));
runTransportConformance('FaultyEndpoint with zero fault rates', async () => ({
  endpoint: new FaultyEndpoint(new ReferenceEndpoint(), { seed: 3 }),
}));
runTransportConformance('HTTP transport against a stub relay', async () => {
  const relay = await stubRelay({ token: 's3cret' });
  return {
    endpoint: httpTransport({ baseUrl: relay.baseUrl, token: 's3cret' }),
    close: relay.close,
  };
});

const W = 'wwwwwwwwwwwwwwwwwwwwwwwwww';

describe('NDJSON helpers', () => {
  it('round-trip pull responses and push requests with many and unicode ops', async () => {
    const ops = await makeOps(W, 200, {
      fields: (i) => ({ t: `l\u00ednea ${i} \u2028 \ud83d\ude00` }),
    });
    const res = {
      endpointId: W,
      durable: { [W]: 200 },
      support: '*' as const,
      blocked: [],
      more: false,
      ops,
    };
    expect(decodePullResponse(encodePullResponse(res))).toEqual(res);
    const req = { replicaId: W, support: { notes: 1 }, ops };
    expect(decodePushRequest(encodePushRequest(req))).toEqual(req);
    expect(decodePullResponse(encodePullResponse({ ...res, ops: [] })).ops).toEqual([]);
  });

  it('rejects malformed messages', () => {
    expect(() => decodePullResponse('')).toThrow(WeaveError);
    expect(() => decodePullResponse('not json\n')).toThrow(WeaveError);
    expect(() => decodePushRequest('{"replicaId":1}\n')).toThrow(WeaveError);
    expect(() => encodePushRequest({ replicaId: W, support: {}, ops: ['a\nb'] })).toThrow(
      WeaveError,
    );
  });
});

describe('HTTP transport error mapping (R10.2)', () => {
  it('a missing or wrong token gives a non-retryable TRANSPORT_ERROR', async () => {
    const relay = await stubRelay({ token: 'right' });
    try {
      for (const token of [undefined, 'wrong']) {
        const t = httpTransport({
          baseUrl: relay.baseUrl,
          ...(token === undefined ? {} : { token }),
        });
        await expect(
          t.pull({ replicaId: W, vector: {}, support: {}, limit: 0 }),
        ).rejects.toMatchObject({
          code: 'TRANSPORT_ERROR',
          retryable: false,
          details: { status: 401 },
        });
      }
    } finally {
      await relay.close();
    }
  });

  it('5xx and 429 are retryable', async () => {
    const statuses = [500, 503, 429];
    const relay = await stubRelay({ failNext: () => statuses.shift() });
    try {
      const t = httpTransport({ baseUrl: relay.baseUrl });
      for (let i = 0; i < 3; i++) {
        await expect(
          t.pull({ replicaId: W, vector: {}, support: {}, limit: 0 }),
        ).rejects.toMatchObject({
          code: 'TRANSPORT_ERROR',
          retryable: true,
        });
      }
      await expect(
        t.pull({ replicaId: W, vector: {}, support: {}, limit: 0 }),
      ).resolves.toMatchObject({ ops: [] });
    } finally {
      await relay.close();
    }
  });

  it('a WEAVE error code in a 4xx body becomes that error', async () => {
    const relay = await stubRelay();
    try {
      const t = httpTransport({ baseUrl: relay.baseUrl });
      const ops = await makeOps(W, 1);
      await expect(
        t.push({ replicaId: W, support: {}, ops: [ops[0]!.replace('"n":0', '"n":1')] }),
      ).rejects.toMatchObject({
        code: 'INTEGRITY_CONFLICT',
        retryable: false,
      });
    } finally {
      await relay.close();
    }
  });

  it('timeouts and unreachable servers are retryable', async () => {
    const slow = await stubRelay({ delayMs: 300 });
    try {
      await expect(
        httpTransport({ baseUrl: slow.baseUrl, timeoutMs: 50 }).pull({
          replicaId: W,
          vector: {},
          support: {},
          limit: 0,
        }),
      ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
    } finally {
      await slow.close();
    }
    await expect(
      httpTransport({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }).pull({
        replicaId: W,
        vector: {},
        support: {},
        limit: 0,
      }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
  });
});

describe('FaultyEndpoint', () => {
  it('is reproducible for a seed and injects every kind of fault', async () => {
    const run = async () => {
      const faulty = new FaultyEndpoint(new ReferenceEndpoint('eeeeeeeeeeeeeeeeeeeeeeeeee'), {
        seed: 11,
        dropRequestRate: 0.2,
        dropResponseRate: 0.2,
        duplicateRate: 0.3,
        reorderRate: 0.5,
        truncateRate: 0.5,
      });
      const ops = await makeOps(W, 6);
      for (let i = 0; i < 30; i++) {
        await faulty.push({ replicaId: W, support: { notes: 1 }, ops }).catch(() => undefined);
        await faulty
          .pull({
            replicaId: 'pppppppppppppppppppppppppp',
            vector: {},
            support: { notes: 1 },
            limit: 10,
          })
          .catch(() => undefined);
      }
      return faulty.calls.map((c) => `${c.method}:${c.fault ?? 'ok'}`);
    };
    const a = await run();
    expect(a).toEqual(await run());
    for (const fault of ['drop-request', 'drop-response', 'duplicate'])
      expect(a.some((c) => c.endsWith(fault))).toBe(true);
  });

  it('hooks see every call', async () => {
    const seen: string[] = [];
    const faulty = new FaultyEndpoint(new ReferenceEndpoint(), {
      hooks: { beforeCall: (m) => void seen.push(m) },
    });
    await faulty.pull({ replicaId: W, vector: {}, support: {}, limit: 0 });
    await faulty.ack({ replicaId: W, durable: {} });
    expect(seen).toEqual(['pull', 'ack']);
  });
});
