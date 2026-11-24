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

/** Type of corruption detected during journal scanning. */
export type CorruptionKind = 'partial-header' | 'header' | 'payload' | 'sequence';

/** A single journal record as parsed during scan. */
export interface ScanRecord {
  /** Transaction ID of the record. */
  readonly txId: number;
  /** Epoch of the record (increases on restarts). */
  readonly epoch: number;
  /** Write set contained in the record. */
  readonly writes: WriteSet;
}

/** Result of scanning a journal buffer. */
export type ScanResult =
  | {
      /** Every record verified and the file ends exactly after the last one. */
      readonly status: 'clean';
      /** The verified records, in order. */
      readonly records: ScanRecord[];
      /** Byte offset just after the last record (the file size). */
      readonly end: number;
    }
  | {
      /** Only case that is truncated automatically: a verified header promises more bytes. */
      readonly status: 'incomplete';
      /** The verified records before the incomplete append. */
      readonly records: ScanRecord[];
      /** Byte offset where the incomplete append starts; the file is cut here. */
      readonly validEnd: number;
    }
  | {
      /** Damage that is not an incomplete append; the open fails with STORAGE_CORRUPT. */
      readonly status: 'corrupt';
      /** The verified records before the damage. */
      readonly records: ScanRecord[];
      /** What is damaged: partial header, header, payload or sequence. */
      readonly kind: CorruptionKind;
      /** Byte offset where the damage starts. */
      readonly offset: number;
      /** Byte offset just after the last valid record. */
      readonly validEnd: number;
      /** True when the explicit operator option may remove the damaged tail (design 9.1 step 7). */
      readonly truncatable: boolean;
      /** A human-readable description of the damage. */
      readonly reason: string;
    };

/** Context passed to scanJournal for generation and epoch validation. */
export interface ScanContext {
  /** Journal generation number to expect in records. */
  readonly generation: number;
  /** Transaction ID covered by the snapshot (first expected txId is snapshotTxId + 1). */
  readonly snapshotTxId: number;
  /** The epoch recorded in MANIFEST before this open bumps it. */
  readonly manifestEpoch: number;
}

/**
 * Scans and validates a journal buffer, returning all valid records or corruption details.
 * @param buf - Buffer containing the journal data.
 * @param ctx - Context with generation, snapshotTxId, and manifestEpoch for validation.
 * @returns A ScanResult describing the scan outcome.
 */
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
