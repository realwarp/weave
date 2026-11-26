/**
 * [ADV] WebSocket transport and direct network sync (task T5.8, R4.4, R9.5): the transport
 * conformance suite, two replicas syncing directly over the network to a verified `complete`,
 * authentication and bound identity, and the server's handling of hostile or broken clients.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createReplica, defineCollection, f, type Replica } from '@weave/core';
import type { AuthContext, SyncEndpoint } from '@weave/core/protocol';
import { memoryStorage } from '../../../storage/src/memory/index.js';
import { fakeClock, fakeScheduler, seededRandom } from '../../../testing/src/faults/index.js';
import {
  ReferenceEndpoint,
  makeOps,
  runTransportConformance,
} from '../../../testing/src/transport/index.js';
import { CLOSE, FrameParser, OPCODE, encodeFrame } from '../../src/websocket/frame.js';
import { websocketTransport, type WebSocketTransport } from '../../src/websocket/index.js';
import { serveWebSocket, type RunningWebSocketEndpoint } from '../../src/websocket/server.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});
async function serve(
  options: Parameters<typeof serveWebSocket>[0],
): Promise<RunningWebSocketEndpoint> {
  const running = await serveWebSocket(options);
  cleanups.push(() => running.close());
  return running;
}
function client(options: Parameters<typeof websocketTransport>[0]): WebSocketTransport {
  const t = websocketTransport(options);
  cleanups.push(() => t.close());
  return t;
}

runTransportConformance('WebSocket transport against a served ReferenceEndpoint', async () => {
  const running = await serveWebSocket({ endpoint: new ReferenceEndpoint(), token: 's3cret' });
  const t = websocketTransport({ url: running.url, token: 's3cret' });
  return {
    endpoint: t,
    close: async () => {
      t.close();
      await running.close();
    },
  };
});

const notes = defineCollection({ name: 'notes', version: 1, fields: { title: f.string() } });
let n = 0;
const replica = (): Promise<Replica> =>
  createReplica({
    storage: memoryStorage(),
    collections: [notes],
    random: seededRandom(`ws-${n++}`),
    clock: fakeClock(),
    scheduler: fakeScheduler(),
  });
let m = 0;
const write = async (r: Replica, count: number) => {
  for (let i = 0; i < count; i++)
    await r.collection(notes).create({ title: `w${i}` }, { mutationId: `ws-${m++}` });
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

describe('direct network sync between two replicas (R4.4)', () => {
  it('both directions reach a verified complete with equal hashes', async () => {
    const [a, b] = [await replica(), await replica()];
    await write(a, 3);
    await write(b, 2);
    const running = await serve({ endpoint: b.endpoint() });
    expect(running.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/ws$/);
    const result = await a.sync(client({ url: running.url }));
    expect(result.status).toBe('complete');
    expect(await a.hashes()).toEqual(await b.hashes());
    // More writes on both sides, then again over the same server.
    await write(a, 1);
    await write(b, 1);
    expect((await a.sync(client({ url: running.url }))).status).toBe('complete');
    expect(await a.hashes()).toEqual(await b.hashes());
    expect((await b.status()).peers[a.id]?.ackVector[a.id]).toBe(4);
  });

  it('a snapshot can be fetched over the network for bootstrapping', async () => {
    const source = await replica();
    await write(source, 2);
    const running = await serve({ endpoint: source.endpoint() });
    const late = await replica();
    await late.bootstrap(client({ url: running.url }));
    expect(await late.hashes()).toEqual(await source.hashes());
  });
});

describe('authentication and identity', () => {
  it('a wrong or missing shared secret is refused at the handshake (retryable TRANSPORT_ERROR)', async () => {
    const running = await serve({ endpoint: new ReferenceEndpoint(), token: 'right' });
    const req = { replicaId: 'a'.repeat(26), vector: {}, support: { notes: 1 }, limit: 0 };
    for (const token of ['wrong', undefined]) {
      const t = client({ url: running.url, ...(token === undefined ? {} : { token }) });
      const e = await t.pull(req).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
    }
    expect(await code(client({ url: running.url, token: 'right' }).pull(req))).toBe('ok');
  });

  it('authenticate binds a trusted identity; a payload cannot override it', async () => {
    const [a, b] = [await replica(), await replica()];
    await write(a, 1);
    const identities = new Map<string, AuthContext>([
      ['alice-secret', { principal: 'alice', writableAs: [a.id] }],
    ]);
    const running = await serve({
      endpoint: (auth) => b.endpoint(auth === undefined ? {} : { auth }),
      authenticate: (secret) => (secret === undefined ? undefined : identities.get(secret)),
    });
    expect((await a.sync(client({ url: running.url, token: 'alice-secret' }))).status).toBe(
      'complete',
    );
    // A third replica using alice's secret, claiming its own ID: refused, nothing stored.
    const mallory = await replica();
    await write(mallory, 1);
    const before = await b.hashes();
    const res = await mallory.sync(client({ url: running.url, token: 'alice-secret' }));
    expect(res.status === 'failed' && res.code).toBe('UNAUTHORIZED');
    expect(await b.hashes()).toEqual(before);
    // An unknown secret does not even connect.
    expect(
      await code(client({ url: running.url, token: 'nope' }).ack({ replicaId: a.id, durable: {} })),
    ).toBe('TRANSPORT_ERROR');
  });

  it('authenticate with a plain endpoint is refused at startup (the identity would be lost)', async () => {
    await expect(
      serveWebSocket({ endpoint: new ReferenceEndpoint(), authenticate: () => null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('errors and connection lifecycle', () => {
  it('endpoint errors keep their WEAVE code; malformed params are VALIDATION_FAILED and store nothing', async () => {
    const endpoint = new ReferenceEndpoint();
    const running = await serve({ endpoint });
    const t = client({ url: running.url });
    const w = 'w'.repeat(26);
    const ops = await makeOps(w, 2);
    const tampered = ops[1]!.replace('"n":1', '"n":9');
    expect(
      await code(t.push({ replicaId: w, support: { notes: 1 }, ops: [ops[0]!, tampered] })),
    ).toBe('INTEGRITY_CONFLICT');
    const bad = [
      { replicaId: 'nope', support: { notes: 1 }, ops },
      { replicaId: w, support: { notes: 0 }, ops },
      { replicaId: w, support: { notes: 1 }, ops: [1] },
    ];
    for (const req of bad) expect(await code(t.push(req as never))).toBe('VALIDATION_FAILED');
    expect(await code(t.pull({ replicaId: w, vector: { [w]: -1 }, support: {}, limit: 0 }))).toBe(
      'VALIDATION_FAILED',
    );
    expect((await t.pull({ replicaId: w, vector: {}, support: {}, limit: 0 })).durable).toEqual({});
  });

  it('a closed server fails requests in flight as retryable; a new server is reached on the next call', async () => {
    let release: () => void = () => undefined;
    const slow: SyncEndpoint = {
      ...new ReferenceEndpoint(),
      pull: () => new Promise((resolve) => (release = () => resolve(undefined as never))),
      push: () => Promise.reject(new Error('unused')),
      ack: () => Promise.resolve(),
    };
    const running = await serveWebSocket({ endpoint: slow });
    const t = client({ url: running.url, timeoutMs: 5_000 });
    const pending = t.pull({ replicaId: 'a'.repeat(26), vector: {}, support: {}, limit: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await running.close();
    expect(await pending.catch((e: unknown) => e)).toMatchObject({
      code: 'TRANSPORT_ERROR',
      retryable: true,
    });
    release();
    // Same transport, a new server on the same port: it reconnects by itself.
    const again = await serve({ endpoint: new ReferenceEndpoint(), port: running.port });
    expect(again.port).toBe(running.port);
    expect(
      await code(t.pull({ replicaId: 'a'.repeat(26), vector: {}, support: {}, limit: 0 })),
    ).toBe('ok');
  });

  it('a request that gets no answer times out as a retryable TRANSPORT_ERROR', async () => {
    const stuck: SyncEndpoint = {
      ...new ReferenceEndpoint(),
      pull: () => new Promise(() => undefined),
      push: () => Promise.reject(new Error('unused')),
      ack: () => Promise.resolve(),
    };
    const running = await serve({ endpoint: stuck });
    const e = await client({ url: running.url, timeoutMs: 200 })
      .pull({ replicaId: 'a'.repeat(26), vector: {}, support: {}, limit: 0 })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
  });
});

/** A raw TCP client that speaks just enough WebSocket to misbehave on purpose. */
async function raw(url: string, protocols = 'weave.v1', path?: string) {
  const u = new URL(url);
  const socket: Socket = connect(Number(u.port), u.hostname);
  cleanups.push(() => void socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    `GET ${path ?? u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Protocol: ${protocols}\r\n\r\n`,
  );
  let head = '';
  let rest = new Uint8Array(0);
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      const end = (head + text).indexOf('\r\n\r\n');
      if (end < 0) {
        head += text;
        return;
      }
      const all = head + text;
      head = all.slice(0, end);
      rest = new Uint8Array(Buffer.from(all.slice(end + 4), 'latin1'));
      socket.off('data', onData);
      resolve();
    };
    socket.on('data', onData);
  });
  const parser = new FrameParser({ maxPayload: 1 << 20, requireMask: false });
  const frames = [...parser.push(rest)];
  socket.on('data', (c: Buffer) => frames.push(...parser.push(new Uint8Array(c))));
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const mask = new Uint8Array([1, 2, 3, 4]);
  return {
    status: Number(head.split(' ')[1]),
    head,
    send: (opcode: number, payload: Uint8Array, masked = true) =>
      socket.write(encodeFrame(opcode, payload, masked ? { mask } : {})),
    sendText: (s: string) =>
      socket.write(encodeFrame(OPCODE.text, new TextEncoder().encode(s), { mask })),
    frames,
    closed,
    closeCode: async () => {
      await closed;
      const c = frames.find((fr) => fr.opcode === OPCODE.close);
      return c === undefined ? undefined : (c.payload[0]! << 8) | c.payload[1]!;
    },
  };
}

describe('the server against hostile or broken clients', () => {
  it('handshake: the accept value, the chosen subprotocol, no secret echoed; bad requests refused', async () => {
    const running = await serve({ endpoint: new ReferenceEndpoint() });
    const ok = await raw(running.url, 'weave.v1, weave.bearer.c2VjcmV0');
    expect(ok.status).toBe(101);
    expect(ok.head).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(ok.head).toContain('Sec-WebSocket-Protocol: weave.v1');
    expect(ok.head).not.toContain('bearer');
    expect((await raw(running.url, 'chat')).status).toBe(400);
    expect((await raw(running.url, 'weave.v1', '/elsewhere')).status).toBe(404);
  });

  it('answers pings, and replies to a request with a valid id even when the method is unknown', async () => {
    const running = await serve({ endpoint: new ReferenceEndpoint() });
    const c = await raw(running.url);
    c.send(OPCODE.ping, new Uint8Array([7, 7]));
    c.sendText('{"id":9,"method":"drop"}');
    await new Promise((r) => setTimeout(r, 100));
    expect(c.frames.find((fr) => fr.opcode === OPCODE.pong)?.payload).toEqual(
      new Uint8Array([7, 7]),
    );
    const reply = c.frames.find((fr) => fr.opcode === OPCODE.text)!;
    expect(JSON.parse(new TextDecoder().decode(reply.payload))).toMatchObject({
      id: 9,
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('closes with the right code: unmasked 1002, binary 1003, too big 1009, no usable id 1008', async () => {
    const running = await serve({ endpoint: new ReferenceEndpoint(), maxMessageBytes: 1_000 });
    const unmasked = await raw(running.url);
    unmasked.send(OPCODE.text, new TextEncoder().encode('{}'), false);
    expect(await unmasked.closeCode()).toBe(CLOSE.protocolError);
    const binary = await raw(running.url);
    binary.send(OPCODE.binary, new Uint8Array([1]));
    expect(await binary.closeCode()).toBe(CLOSE.unsupportedData);
    const big = await raw(running.url);
    big.sendText('x'.repeat(1_001));
    expect(await big.closeCode()).toBe(CLOSE.tooBig);
    const junk = await raw(running.url);
    junk.sendText('not json');
    expect(await junk.closeCode()).toBe(CLOSE.policy);
  });
});
