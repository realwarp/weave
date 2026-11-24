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

/** Magic bytes identifying a valid journal record (WJ02). */
export const MAGIC = Buffer.from('WJ02', 'ascii');
/** Number of bytes in a journal record header (32). */
export const HEADER_BYTES = 32;
/** Number of bytes in a journal record trailer (32). */
export const TRAILER_BYTES = 32;
/** Maximum allowed payload size in bytes (64 MiB). */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** A write set is an immutable sequence of key-value pairs. */
export type WriteSet = ReadonlyArray<readonly [string, string | null]>;

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Header fields of a journal record. */
export interface RecordHeader {
  /** Journal generation number. */
  readonly generation: number;
  /** Transaction epoch (monotonically increases on restarts). */
  readonly epoch: number;
  /** Transaction ID (monotonically increases within a generation). */
  readonly txId: number;
  /** Size of the payload in bytes. */
  readonly payloadLen: number;
}

/**
 * Encodes a journal record with header, payload, and trailer.
 * @param header - Record header fields (excluding payloadLen which is computed).
 * @param writes - Write set to include as payload.
 * @returns The complete encoded record buffer.
 */
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

/**
 * Decodes and verifies a journal record header.
 * @param buf - Buffer containing the record.
 * @param offset - Byte offset to the start of the header.
 * @returns The header fields if the magic and header check verify; undefined otherwise.
 */
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

/**
 * Verifies the trailer checksum of a journal record.
 * @param buf - Buffer containing the record.
 * @param offset - Byte offset to the start of the record header.
 * @param payloadLen - Expected payload length from the decoded header.
 * @returns True if the trailer matches the expected checksum.
 */
export function trailerMatches(buf: Buffer, offset: number, payloadLen: number): boolean {
  const end = offset + HEADER_BYTES + payloadLen;
  const expected = sha256(buf.subarray(offset, end));
  return expected.equals(buf.subarray(end, end + TRAILER_BYTES));
}

/**
 * Parses and validates a write set from bytes.
 * @param bytes - Buffer containing the JSON-encoded write set.
 * @returns The parsed write set if valid; undefined if parsing or validation fails.
 */
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

/**
 * Computes a SHA-256 checksum over a snapshot's transaction ID and entries.
 * @param txId - Transaction ID of the snapshot.
 * @param entries - Key-value entries in the snapshot.
 * @returns Hex string of the checksum.
 */
export function snapshotChecksum(
  txId: number,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([txId, entries]), 'utf8')
    .digest('hex');
}
