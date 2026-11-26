/**
 * [ADV] WebSocket framing (RFC 6455 section 5), used by the Node server in `server.ts` (task T5.8,
 * R4.4, R9.5). Plain `Uint8Array` code with no Node or DOM API, so it is portable and unit
 * testable. Browser and Node clients use the platform `WebSocket`, which does its own framing.
 */

/** Frame opcodes (RFC 6455 section 5.2). */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Close codes used by WEAVE (RFC 6455 section 7.4.1). */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  policy: 1008,
  tooBig: 1009,
} as const;

/** One decoded frame. */
export interface Frame {
  /** FIN bit: the last frame of a message. */
  readonly fin: boolean;
  /** The opcode. */
  readonly opcode: number;
  /** The payload, already unmasked. */
  readonly payload: Uint8Array;
  /** Whether the frame was masked on the wire. */
  readonly masked: boolean;
}

/** A framing violation; the connection must be closed with `code`. */
export class FrameError extends Error {
  constructor(
    message: string,
    /** The close code to send. */
    readonly code: number,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Encodes one frame. Servers send unmasked frames; pass `mask` (4 bytes) only for client frames.
 */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  options: { readonly fin?: boolean; readonly mask?: Uint8Array } = {},
): Uint8Array {
  const fin = options.fin ?? true;
  const mask = options.mask;
  const len = payload.length;
  const extra = len < 126 ? 0 : len < 65_536 ? 2 : 8;
  const out = new Uint8Array(2 + extra + (mask === undefined ? 0 : 4) + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const maskBit = mask === undefined ? 0 : 0x80;
  let at = 2;
  if (extra === 0) out[1] = maskBit | len;
  else if (extra === 2) {
    out[1] = maskBit | 126;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
    at = 4;
  } else {
    out[1] = maskBit | 127;
    // Payloads are far below 2^53; the high 32 bits are written as a plain number.
    const high = Math.floor(len / 0x1_0000_0000);
    const low = len >>> 0;
    const view = new DataView(out.buffer);
    view.setUint32(2, high);
    view.setUint32(6, low);
    at = 10;
  }
  if (mask !== undefined) {
    if (mask.length !== 4) throw new RangeError('A mask has 4 bytes');
    out.set(mask, at);
    at += 4;
    for (let i = 0; i < len; i++) out[at + i] = payload[i]! ^ mask[i & 3]!;
  } else out.set(payload, at);
  return out;
}

/** Options of the incremental frame parser. */
export interface ParserOptions {
  /** The largest frame payload accepted (bytes). */
  readonly maxPayload: number;
  /** Require masked frames (true on a server, RFC 6455 section 5.1). */
  readonly requireMask: boolean;
}

/**
 * Incremental frame parser: feed it chunks in arrival order and it returns every complete frame.
 * Throws `FrameError` on a protocol violation; the caller then closes the connection.
 */
export class FrameParser {
  /**
   * Received bytes not yet parsed, as chunks. They are joined only once at least `need` bytes
   * are present, so each byte is copied a few times per frame: linear work even when a client
   * drips a large frame one byte at a time (no quadratic CPU cost, review T5.8).
   */
  private parts: Uint8Array[] = [];
  private size = 0;
  /** Bytes needed before parsing can make progress (2 for a frame header). */
  private need = 2;

  constructor(private readonly options: ParserOptions) {}

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      this.parts.push(chunk);
      this.size += chunk.length;
    }
    const frames: Frame[] = [];
    while (this.size >= this.need) {
      const b = this.joined();
      const result = this.next(b);
      if (typeof result === 'number') {
        this.need = result;
        break;
      }
      frames.push(result.frame);
      const rest = b.subarray(result.used);
      this.parts = rest.length === 0 ? [] : [rest];
      this.size = rest.length;
      this.need = 2;
    }
    return frames;
  }

  private joined(): Uint8Array {
    if (this.parts.length === 1) return this.parts[0]!;
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    this.parts = [all];
    return all;
  }

  /** The next frame and the bytes it used, or the total byte count needed to go on. */
  private next(b: Uint8Array): { frame: Frame; used: number } | number {
    if (b.length < 2) return 2;
    const first = b[0]!;
    const second = b[1]!;
    if ((first & 0x70) !== 0)
      throw new FrameError('Reserved bits must be zero', CLOSE.protocolError);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (this.options.requireMask && !masked)
      throw new FrameError('Client frames must be masked', CLOSE.protocolError);
    if (!this.options.requireMask && masked)
      throw new FrameError('Server frames must not be masked', CLOSE.protocolError);
    let len = second & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return 4;
      len = (b[2]! << 8) | b[3]!;
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return 10;
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const high = view.getUint32(2);
      const low = view.getUint32(6);
      if (high > 0x1f_ffff) throw new FrameError('Frame too large', CLOSE.tooBig);
      len = high * 0x1_0000_0000 + low;
      at = 10;
    }
    const control = (opcode & 0x08) !== 0;
    if (control && (len > 125 || !fin))
      throw new FrameError('Control frames are short and not fragmented', CLOSE.protocolError);
    if (len > this.options.maxPayload) throw new FrameError('Frame too large', CLOSE.tooBig);
    const maskAt = at;
    if (masked) at += 4;
    // The size checks above ran first, so at most one allowed frame is ever buffered.
    if (b.length < at + len) return at + len;
    const payload = b.slice(at, at + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ b[maskAt + (i & 3)]!;
    return { frame: { fin, opcode, payload, masked }, used: at + len };
  }
}

/**
 * Joins fragmented data frames into messages (RFC 6455 section 5.4). Returns a complete text
 * message, or `undefined` while one is still being assembled.
 * @throws FrameError for binary data, a stray continuation, or a message over `maxMessage`.
 */
export class MessageAssembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  private active = false;

  constructor(private readonly maxMessage: number) {}

  add(frame: Frame): string | undefined {
    if (frame.opcode === OPCODE.binary)
      throw new FrameError('Only text messages are accepted', CLOSE.unsupportedData);
    if (frame.opcode === OPCODE.text) {
      if (this.active)
        throw new FrameError('A new message started inside a fragmented one', CLOSE.protocolError);
      this.active = true;
    } else if (frame.opcode === OPCODE.continuation) {
      if (!this.active) throw new FrameError('Continuation without a message', CLOSE.protocolError);
    } else throw new FrameError('Unknown opcode', CLOSE.protocolError);
    this.size += frame.payload.length;
    if (this.size > this.maxMessage) throw new FrameError('Message too large', CLOSE.tooBig);
    this.parts.push(frame.payload);
    if (!frame.fin) return undefined;
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    this.parts = [];
    this.size = 0;
    this.active = false;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(all);
    } catch {
      throw new FrameError('Text message is not valid UTF-8', CLOSE.invalidPayload);
    }
  }
}
