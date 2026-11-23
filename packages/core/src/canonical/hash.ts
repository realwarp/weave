/**
 * SHA-256 hashing and the hash inputs of D2 and D7 (design 4, item 5).
 * Uses the platform crypto API (Node.js 22 and browsers), so no dependency is needed.
 */
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type { OpPayload } from '../contracts/op.js';
import { compareUtf8, encodeCanonical, toCanonical, utf8Bytes } from './encode.js';

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) {
    throw new WeaveError('STORAGE_ERROR', 'globalThis.crypto.subtle is not available');
  }
  return s;
}

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', utf8Bytes(text));
  return bytesToHex(new Uint8Array(digest));
}

/** The exact object that is hashed for an op (D2): never `hash`, never `wallTime`. */
export function opPayloadOf(op: OpPayload): OpPayload {
  return {
    replicaId: op.replicaId,
    seq: op.seq,
    lamport: op.lamport,
    context: op.context,
    collection: op.collection,
    recordId: op.recordId,
    kind: op.kind,
    schemaVersion: op.schemaVersion,
    fields: op.fields,
  };
}

/** SHA-256 over the canonical encoding of the D2 payload. */
export function opHash(op: OpPayload): Promise<string> {
  return sha256Hex(toCanonical(opPayloadOf(op)));
}

/** One record in the state hash: `[collection, recordId, deleted, resolvedFields]`. */
export type StateEntry = readonly [string, string, boolean, Readonly<Record<string, JsonValue>>];

/** State hash (D7): entries sorted by `(collection, recordId)` in UTF-8 byte order. */
export function stateHash(entries: readonly StateEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => compareUtf8(a[0], b[0]) || compareUtf8(a[1], b[1]));
  const normalized = sorted.map(([c, r, deleted, fields]) => [
    c,
    r,
    deleted,
    deleted ? {} : fields,
  ]);
  return sha256Hex(encodeCanonical(normalized));
}

/** Op-set hash (D7): sorted list of the hashes of all accepted ops. */
export function opSetHash(opHashes: readonly string[]): Promise<string> {
  return sha256Hex(encodeCanonical([...opHashes].sort(compareUtf8)));
}

/** Conflict-view hash (D7): sorted `[conflictId, resolvedValue]` pairs of open conflicts. */
export function conflictViewHash(
  pairs: ReadonlyArray<readonly [string, JsonValue | undefined]>,
): Promise<string> {
  const sorted = [...pairs]
    .sort((a, b) => compareUtf8(a[0], b[0]))
    .map(([id, value]) => [id, value === undefined ? null : value]);
  return sha256Hex(encodeCanonical(sorted));
}

/** Mutation payload hash (design 4, 7.2) used to detect `MUTATION_ID_REUSED`. */
export function mutationPayloadHash(input: {
  readonly collection: string;
  readonly kind: 'set' | 'delete';
  readonly recordId: string | null;
  readonly fields: Readonly<Record<string, JsonValue>>;
}): Promise<string> {
  return sha256Hex(
    toCanonical({
      collection: input.collection,
      kind: input.kind,
      recordId: input.recordId,
      fields: input.fields,
    }),
  );
}

/** Hash of an arbitrary list of strings, used for conflict IDs (D8). */
export function hashOfCanonical(value: unknown): Promise<string> {
  return sha256Hex(toCanonical(value));
}
