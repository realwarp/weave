/**
 * [ADV] WebSocket framing and message codec (task T5.8): RFC 6455 length forms, masking, split
 * delivery, fragmentation, and every protocol violation the server closes on.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  FrameError,
  FrameParser,
  MessageAssembler,
  OPCODE,
  encodeFrame,
} from '../../src/websocket/frame.js';
import {
  decodeBearer,
  encodeBearer,
  fromRpcError,
  parseRequest,
  parseResponse,
  toRpcError,
} from '../../src/websocket/rpc.js';
import { WeaveError } from '@weave/core/protocol';

const MASK = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const server = () => new FrameParser({ maxPayload: 1 << 20, requireMask: true });
const closeCode = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FrameError) return e.code;
    throw e;
  }
  throw new Error('expected a FrameError');
};

describe('frames (RFC 6455 section 5)', () => {
  it('round-trips every length form, masked, even when delivered one byte at a time', () => {
    for (const n of [0, 1, 125, 126, 127, 65_535, 65_536, 70_000]) {
      const payload = bytes(n);
      const wire = encodeFrame(OPCODE.text, payload, { mask: MASK });
      const headerLen = n < 126 ? 2 : n < 65_536 ? 4 : 10;
      expect(wire.length).toBe(headerLen + 4 + n);
      const whole = server().push(wire);
      expect(whole).toHaveLength(1);
      expect(whole[0]!.payload).toEqual(payload);
      expect(whole[0]!.masked).toBe(true);
      if (n <= 300) {
        const p = server();
        const frames = [];
        for (const b of wire) frames.push(...p.push(new Uint8Array([b])));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.payload).toEqual(payload);
      }
    }
  });

  it('server frames are unmasked; a client parser rejects masked ones and vice versa', () => {
    const unmasked = encodeFrame(OPCODE.text, bytes(3));
    expect(unmasked[1]! & 0x80).toBe(0);
    const client = new FrameParser({ maxPayload: 100, requireMask: false });
    expect(client.push(unmasked)[0]!.payload).toEqual(bytes(3));
    expect(closeCode(() => server().push(unmasked))).toBe(CLOSE.protocolError);
    expect(closeCode(() => client.push(encodeFrame(OPCODE.text, bytes(3), { mask: MASK })))).toBe(
      CLOSE.protocolError,
    );
  });

  it('a large frame dripped one byte at a time costs linear, not quadratic, work (review T5.8)', () => {
    // 256 KiB in 1-byte chunks. A parser that re-joins its whole buffer per chunk copies about
    // 34 GB here; a linear one copies each byte a few times.
    const payload = bytes(256 * 1024);
    const wire = encodeFrame(OPCODE.text, payload, { mask: MASK });
    const p = server();
    const started = performance.now();
    const frames = [];
    for (let i = 0; i < wire.length; i++) frames.push(...p.push(wire.subarray(i, i + 1)));
    const ms = performance.now() - started;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual(payload);
    expect(ms).toBeLessThan(3_000);
  });

  it('several frames in one chunk are all returned in order', () => {
    const a = encodeFrame(OPCODE.text, bytes(5), { mask: MASK });
    const b = encodeFrame(OPCODE.ping, bytes(2), { mask: MASK });
    const both = new Uint8Array([...a, ...b]);
    expect(
      server()
        .push(both)
        .map((f) => f.opcode),
    ).toEqual([OPCODE.text, OPCODE.ping]);
  });

  it('closes on reserved bits, long or fragmented control frames, and oversized frames', () => {
    const rsv = encodeFrame(OPCODE.text, bytes(1), { mask: MASK });
    rsv[0] = rsv[0]! | 0x40;
    expect(closeCode(() => server().push(rsv))).toBe(CLOSE.protocolError);
    expect(
      closeCode(() => server().push(encodeFrame(OPCODE.ping, bytes(126), { mask: MASK }))),
    ).toBe(CLOSE.protocolError);
    expect(
      closeCode(() =>
        server().push(encodeFrame(OPCODE.ping, bytes(1), { mask: MASK, fin: false })),
      ),
    ).toBe(CLOSE.protocolError);
    const small = new FrameParser({ maxPayload: 10, requireMask: true });
    expect(closeCode(() => small.push(encodeFrame(OPCODE.text, bytes(11), { mask: MASK })))).toBe(
      CLOSE.tooBig,
    );
  });
});

describe('messages', () => {
  const text = (s: string, fin = true, opcode: number = OPCODE.text) => ({
    fin,
    opcode,
    payload: new TextEncoder().encode(s),
    masked: true,
  });

  it('joins fragments into one UTF-8 message', () => {
    const m = new MessageAssembler(100);
    const whole = new TextEncoder().encode('café 😀');
    const first = { fin: false, opcode: OPCODE.text, payload: whole.slice(0, 4), masked: true };
    const second = {
      fin: true,
      opcode: OPCODE.continuation,
      payload: whole.slice(4),
      masked: true,
    };
    expect(m.add(first)).toBeUndefined();
    expect(m.add(second)).toBe('café 😀');
    expect(m.add(text('next'))).toBe('next');
  });

  it('closes on binary data, stray continuations, nested starts, size and bad UTF-8', () => {
    expect(closeCode(() => new MessageAssembler(100).add(text('x', true, OPCODE.binary)))).toBe(
      CLOSE.unsupportedData,
    );
    expect(
      closeCode(() => new MessageAssembler(100).add(text('x', true, OPCODE.continuation))),
    ).toBe(CLOSE.protocolError);
    const nested = new MessageAssembler(100);
    nested.add(text('a', false));
    expect(closeCode(() => nested.add(text('b')))).toBe(CLOSE.protocolError);
    const big = new MessageAssembler(5);
    big.add(text('abc', false));
    expect(closeCode(() => big.add(text('def', true, OPCODE.continuation)))).toBe(CLOSE.tooBig);
    const bad = {
      fin: true,
      opcode: OPCODE.text,
      payload: new Uint8Array([0xc3, 0x28]),
      masked: true,
    };
    expect(closeCode(() => new MessageAssembler(100).add(bad))).toBe(CLOSE.invalidPayload);
  });
});

describe('request and response messages', () => {
  it('parses valid requests and rejects malformed ones with VALIDATION_FAILED', () => {
    expect(parseRequest('{"id":3,"method":"pull","params":{}}')).toEqual({
      id: 3,
      method: 'pull',
      params: {},
    });
    for (const bad of [
      'nope',
      '[]',
      '{"id":0,"method":"pull"}',
      '{"id":1,"method":"drop"}',
      '{"id":1.5,"method":"ack"}',
    ])
      expect(() => parseRequest(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error,
      );
    expect(parseResponse('{"id":1,"result":2}')).toEqual({ id: 1, result: 2 });
    expect(parseResponse('{"id":1,"error":{"code":5}}')).toBeUndefined();
    expect(parseResponse('x')).toBeUndefined();
  });

  it('errors keep their code and retryability; unknown codes become TRANSPORT_ERROR; no stacks', () => {
    const wire = toRpcError(
      new WeaveError('INTEGRITY_CONFLICT', 'two versions', { details: { seq: 2 } }),
    );
    expect(wire).toEqual({
      code: 'INTEGRITY_CONFLICT',
      message: 'two versions',
      details: { seq: 2 },
    });
    expect(fromRpcError(wire)).toMatchObject({ code: 'INTEGRITY_CONFLICT', retryable: false });
    expect(toRpcError(new WeaveError('STORAGE_CONFLICT', 'x')).retryable).toBe(true);
    expect(toRpcError(new Error('secret path /x'))).toEqual({
      code: 'TRANSPORT_ERROR',
      message: 'Internal error',
      retryable: true,
    });
    expect(fromRpcError({ code: 'MADE_UP', message: 'x' })).toMatchObject({
      code: 'TRANSPORT_ERROR',
      details: { remoteCode: 'MADE_UP' },
    });
  });

  it('bearer secrets survive the subprotocol encoding, including non-ASCII', () => {
    for (const s of ['s3cret', 'p@ss word/+=', 'clé-🔑']) {
      const entry = encodeBearer(s);
      expect(entry).toMatch(/^weave\.bearer\.[A-Za-z0-9_-]*$/);
      expect(decodeBearer(entry)).toBe(s);
    }
    expect(decodeBearer('weave.v1')).toBeUndefined();
    expect(decodeBearer('weave.bearer.%%%')).toBeUndefined();
  });
});
