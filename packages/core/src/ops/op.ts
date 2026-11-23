/**
 * Building, serializing and verifying ops (D1, D2, design 3.2, 3.3, 7.3 Phase A1).
 */
import {
  assertSupported,
  encodeCanonical,
  hasLoneSurrogate,
  toCanonical,
  utf8Length,
} from '../canonical/encode.js';
import { opHash } from '../canonical/hash.js';
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue, ReplicaId, VersionVector } from '../contracts/json.js';
import type { Op, OpPayload } from '../contracts/op.js';
import { REPLICA_ID_PATTERN } from './random.js';
import { normalizeVector } from './vector.js';

export const COLLECTION_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Default size limit of one op line (design 4). */
export const DEFAULT_MAX_OP_BYTES = 64 * 1024;

export interface BuildOpInput {
  readonly replicaId: ReplicaId;
  /** The writer's ACCEPTED vector (D2). Its own entry is `seq - 1`. */
  readonly vector: VersionVector;
  /** Max lamport over ACCEPTED ops (D2). */
  readonly maxLamport: number;
  readonly collection: string;
  readonly recordId: string;
  readonly kind: 'set' | 'delete';
  readonly schemaVersion: number;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly wallTime?: number;
  readonly maxOpBytes?: number;
}

/** Builds a complete, hashed op from the accepted state of the writer (design 7.2 step 4). */
export async function buildOp(input: BuildOpInput): Promise<{ op: Op; line: string }> {
  const context = normalizeVector(input.vector);
  const payload: OpPayload = {
    replicaId: input.replicaId,
    seq: (context[input.replicaId] ?? 0) + 1,
    lamport: input.maxLamport + 1,
    context,
    collection: input.collection,
    recordId: input.recordId,
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    fields: input.kind === 'delete' ? {} : input.fields,
  };
  validatePayloadShape(payload);
  const hash = await opHash(payload);
  const op: Op =
    input.wallTime === undefined
      ? { ...payload, hash }
      : { ...payload, hash, wallTime: input.wallTime };
  const line = serializeOp(op);
  const max = input.maxOpBytes ?? DEFAULT_MAX_OP_BYTES;
  if (utf8Length(line) > max) {
    throw new WeaveError('VALIDATION_FAILED', `Op is larger than ${max} bytes`, {
      details: { bytes: utf8Length(line) },
    });
  }
  return { op, line };
}

/** The canonical wire and storage line of an op (design 3.3): one line, no newline inside. */
export function serializeOp(op: Op): string {
  return toCanonical(op);
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new WeaveError('VALIDATION_FAILED', message, { details });
}

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Structural checks shared by `buildOp` and `verifyOpLine`. Throws VALIDATION_FAILED. */
function validatePayloadShape(p: {
  replicaId: unknown;
  seq: unknown;
  lamport: unknown;
  context: unknown;
  collection: unknown;
  recordId: unknown;
  kind: unknown;
  schemaVersion: unknown;
  fields: unknown;
}): void {
  if (typeof p.replicaId !== 'string' || !REPLICA_ID_PATTERN.test(p.replicaId)) {
    invalid('Invalid replicaId', { replicaId: p.replicaId });
  }
  if (!isPositiveInt(p.seq)) invalid('Invalid seq', { seq: p.seq });
  if (!isPositiveInt(p.lamport)) invalid('Invalid lamport', { lamport: p.lamport });
  if (typeof p.collection !== 'string' || !COLLECTION_PATTERN.test(p.collection)) {
    invalid('Invalid collection name', { collection: p.collection });
  }
  if (typeof p.recordId !== 'string' || !RECORD_ID_PATTERN.test(p.recordId)) {
    invalid('Invalid recordId', { recordId: p.recordId });
  }
  if (p.kind === 'restore') {
    throw new WeaveError(
      'NOT_SUPPORTED',
      'The restore op kind is an [ADV] feature and is not supported',
    );
  }
  if (p.kind !== 'set' && p.kind !== 'delete') invalid('Invalid op kind', { kind: p.kind });
  if (!isPositiveInt(p.schemaVersion))
    invalid('Invalid schemaVersion', { schemaVersion: p.schemaVersion });
  if (!isPlainObject(p.context)) invalid('context must be an object');
  for (const [origin, seq] of Object.entries(p.context)) {
    if (!REPLICA_ID_PATTERN.test(origin)) invalid('Invalid replica ID in context', { origin });
    if (!isNonNegativeInt(seq)) invalid('Invalid context entry', { origin, seq });
  }
  // The writer had accepted exactly its own seq - 1 earlier ops (D1, D2).
  const own = (p.context as Record<string, number>)[p.replicaId as string] ?? 0;
  if (own !== (p.seq as number) - 1) {
    invalid('context entry of the writer must equal seq - 1', { seq: p.seq, own });
  }
  if (!isPlainObject(p.fields)) invalid('fields must be an object');
  for (const name of Object.keys(p.fields)) {
    if (name.length === 0 || name.includes('\u0000') || hasLoneSurrogate(name)) {
      invalid('Invalid field name', { name });
    }
  }
  if (p.kind === 'delete' && Object.keys(p.fields).length > 0) {
    invalid('A delete op must have empty fields');
  }
  assertSupported(p.fields);
}

const REQUIRED_KEYS = [
  'collection',
  'context',
  'fields',
  'hash',
  'kind',
  'lamport',
  'recordId',
  'replicaId',
  'schemaVersion',
  'seq',
] as const;

export interface VerifyOptions {
  readonly maxOpBytes?: number;
}

/**
 * Parses and fully verifies one received op line (design 7.3 Phase A1, R16.1, R16.2):
 * size, JSON structure with the exact key set, value rules (D7), canonical form, and the hash
 * recomputed over the D2 payload. Throws VALIDATION_FAILED, UNSUPPORTED_VALUE, NOT_SUPPORTED or
 * INTEGRITY_CONFLICT. Does NOT apply any application schema.
 */
export async function verifyOpLine(line: string, options: VerifyOptions = {}): Promise<Op> {
  if (typeof line !== 'string') invalid('Op line must be a string');
  const max = options.maxOpBytes ?? DEFAULT_MAX_OP_BYTES;
  const bytes = utf8Length(line);
  if (bytes > max) invalid(`Op line is larger than ${max} bytes`, { bytes });
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    invalid('Op line is not valid JSON');
  }
  if (!isPlainObject(parsed)) invalid('Op line must be a JSON object');
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key) && key !== 'wallTime') {
      invalid('Unknown property on op', { key });
    }
  }
  for (const key of REQUIRED_KEYS) if (!(key in parsed)) invalid('Missing property on op', { key });
  validatePayloadShape(parsed as Parameters<typeof validatePayloadShape>[0]);
  const hash = parsed['hash'];
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) invalid('Invalid hash format');
  if ('wallTime' in parsed) {
    const wt = parsed['wallTime'];
    if (typeof wt !== 'number' || !Number.isFinite(wt)) invalid('Invalid wallTime');
  }
  assertSupported(parsed);
  if (encodeCanonical(parsed) !== line) invalid('Op line is not in canonical form');
  const op = parsed as unknown as Op;
  const expected = await opHash(op);
  if (expected !== hash) {
    throw new WeaveError('INTEGRITY_CONFLICT', 'Op hash does not match its content', {
      details: { replicaId: op.replicaId, seq: op.seq },
    });
  }
  return op;
}

/** Reads the envelope fields of a stored, already verified line without re-verifying it. */
export function readEnvelope(line: string): {
  replicaId: string;
  seq: number;
  collection: string;
  schemaVersion: number;
  hash: string;
} {
  const op = JSON.parse(line) as Op;
  return {
    replicaId: op.replicaId,
    seq: op.seq,
    collection: op.collection,
    schemaVersion: op.schemaVersion,
    hash: op.hash,
  };
}
