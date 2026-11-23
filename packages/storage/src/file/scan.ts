/**
 * Read-only journal scan, steps D1 to D6 of design 9.1. Never modifies anything.
 */
import {
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  TRAILER_BYTES,
  decodeHeader,
  parseWriteSet,
  trailerMatches,
  type WriteSet,
} from './format.js';

export type CorruptionKind = 'partial-header' | 'header' | 'payload' | 'sequence';

export interface ScanRecord {
  readonly txId: number;
  readonly epoch: number;
  readonly writes: WriteSet;
}

export type ScanResult =
  | { readonly status: 'clean'; readonly records: ScanRecord[]; readonly end: number }
  | {
      /** Only case that is truncated automatically: a verified header promises more bytes. */
      readonly status: 'incomplete';
      readonly records: ScanRecord[];
      readonly validEnd: number;
    }
  | {
      readonly status: 'corrupt';
      readonly records: ScanRecord[];
      readonly kind: CorruptionKind;
      readonly offset: number;
      readonly validEnd: number;
      /** True when the explicit operator option may remove the damaged tail (design 9.1 step 7). */
      readonly truncatable: boolean;
      readonly reason: string;
    };

export interface ScanContext {
  readonly generation: number;
  readonly snapshotTxId: number;
  /** The epoch recorded in MANIFEST before this open bumps it. */
  readonly manifestEpoch: number;
}

export function scanJournal(buf: Buffer, ctx: ScanContext): ScanResult {
  const records: ScanRecord[] = [];
  let offset = 0;
  let prevTxId = ctx.snapshotTxId;
  let prevEpoch = 0;
  const corrupt = (kind: CorruptionKind, reason: string, truncatable = false): ScanResult => ({
    status: 'corrupt',
    records,
    kind,
    offset,
    validEnd: offset,
    truncatable,
    reason,
  });

  while (offset < buf.length) {
    const remaining = buf.length - offset;
    // D1: fewer bytes than a header: the length cannot be verified, so fail closed.
    if (remaining < HEADER_BYTES) {
      return corrupt('partial-header', `only ${remaining} bytes after the last valid record`, true);
    }
    // D2: header must verify (covers magic, generation, epoch, txId and the length field).
    const header = decodeHeader(buf, offset);
    if (header === undefined) return corrupt('header', 'record header does not verify');
    // D3: limits, generation, then the only auto-truncated case.
    if (header.payloadLen > MAX_PAYLOAD_BYTES)
      return corrupt('header', 'payload length above the limit');
    if (header.generation !== ctx.generation)
      return corrupt('header', 'record of another generation');
    const total = HEADER_BYTES + header.payloadLen + TRAILER_BYTES;
    if (total > remaining) return { status: 'incomplete', records, validEnd: offset };
    // D4: a complete record must have a matching trailer, also when it is the last record.
    if (!trailerMatches(buf, offset, header.payloadLen)) {
      return corrupt('payload', 'record checksum mismatch', offset + total === buf.length);
    }
    // D5: sequence and epoch.
    if (header.txId !== prevTxId + 1) {
      return corrupt('sequence', `expected txId ${prevTxId + 1}, found ${header.txId}`);
    }
    if (header.epoch < prevEpoch) return corrupt('sequence', 'epoch went backwards (two writers)');
    if (header.epoch > ctx.manifestEpoch) return corrupt('sequence', 'epoch newer than MANIFEST');
    const writes = parseWriteSet(
      buf.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + header.payloadLen),
    );
    if (writes === undefined) return corrupt('payload', 'payload is not a valid write set');
    // D6: accept.
    records.push({ txId: header.txId, epoch: header.epoch, writes });
    prevTxId = header.txId;
    prevEpoch = header.epoch;
    offset += total;
  }
  return { status: 'clean', records, end: offset };
}
