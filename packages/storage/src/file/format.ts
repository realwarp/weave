/**
 * Journal record format (design 9.1):
 *
 *   header (32 bytes): magic "WJ02" | generation u32 | epoch u32 | txId u64 | payloadLen u32 |
 *                      headerCheck (first 8 bytes of SHA-256 over the 24 bytes before it)
 *   payload (payloadLen bytes): JSON write set [[key, value | null], ...]
 *   trailer (32 bytes): SHA-256 over the 32 header bytes followed by the payload
 *
 * The header check covers the length field, so a damaged length is detected as corruption and is
 * never mistaken for an incomplete append.
 */
import { createHash } from 'node:crypto';

export const MAGIC = Buffer.from('WJ02', 'ascii');
export const HEADER_BYTES = 32;
export const TRAILER_BYTES = 32;
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type WriteSet = ReadonlyArray<readonly [string, string | null]>;

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export interface RecordHeader {
  readonly generation: number;
  readonly epoch: number;
  readonly txId: number;
  readonly payloadLen: number;
}

export function encodeRecord(header: Omit<RecordHeader, 'payloadLen'>, writes: WriteSet): Buffer {
  const payload = Buffer.from(JSON.stringify(writes), 'utf8');
  const head = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(header.generation, 4);
  head.writeUInt32BE(header.epoch, 8);
  head.writeBigUInt64BE(BigInt(header.txId), 12);
  head.writeUInt32BE(payload.length, 20);
  sha256(head.subarray(0, 24)).copy(head, 24, 0, 8);
  const trailer = sha256(head, payload);
  return Buffer.concat([head, payload, trailer]);
}

/** Verifies magic and header check. Returns undefined when the header does not verify. */
export function decodeHeader(buf: Buffer, offset: number): RecordHeader | undefined {
  const head = buf.subarray(offset, offset + HEADER_BYTES);
  if (head.length < HEADER_BYTES) return undefined;
  if (!head.subarray(0, 4).equals(MAGIC)) return undefined;
  const check = sha256(head.subarray(0, 24)).subarray(0, 8);
  if (!check.equals(head.subarray(24, 32))) return undefined;
  const txId = head.readBigUInt64BE(12);
  if (txId > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return {
    generation: head.readUInt32BE(4),
    epoch: head.readUInt32BE(8),
    txId: Number(txId),
    payloadLen: head.readUInt32BE(20),
  };
}

export function trailerMatches(buf: Buffer, offset: number, payloadLen: number): boolean {
  const end = offset + HEADER_BYTES + payloadLen;
  const expected = sha256(buf.subarray(offset, end));
  return expected.equals(buf.subarray(end, end + TRAILER_BYTES));
}

export function parseWriteSet(bytes: Buffer): WriteSet | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 2) return undefined;
    if (typeof item[0] !== 'string') return undefined;
    if (item[1] !== null && typeof item[1] !== 'string') return undefined;
  }
  return parsed as WriteSet;
}

export function snapshotChecksum(
  txId: number,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([txId, entries]), 'utf8')
    .digest('hex');
}
