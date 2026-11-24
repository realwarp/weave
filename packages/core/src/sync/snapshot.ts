/**
 * [ADV] Snapshots for bootstrapping (R4.8, ADR-0015). A snapshot carries the source's accepted op
 * lines (tombstones included), its vectors and the conflict history kept after compaction. The
 * importer verifies the hash and every op line, checks that the op lines are exactly what the
 * vectors promise, and re-derives every record itself: derived state is never trusted.
 *
 * Opaque parts (`hashSnapshot`, `verifySnapshotEnvelope`) read only envelopes and hashes, so the
 * relay can store and serve snapshots without knowing any schema.
 */
import { toCanonical } from '../canonical/encode.js';
import { sha256Hex } from '../canonical/hash.js';
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue, VersionVector } from '../contracts/json.js';
import type { Op } from '../contracts/op.js';
import type { Snapshot } from '../contracts/sync.js';
import { verifyOpLine } from '../ops/op.js';
import { normalizeVector } from '../ops/vector.js';

/** The snapshot format this version writes and reads. */
export const SNAPSHOT_FORMAT = 'weave-snapshot/1' as const;

type Unhashed = Omit<Snapshot, 'hash'>;

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new WeaveError('VALIDATION_FAILED', `Invalid snapshot: ${message}`, { details });
}

/** SHA-256 over the canonical encoding of every field except `hash`. */
export async function hashSnapshot(snapshot: Unhashed): Promise<string> {
  const { format, source, vector, maxLamport, compactedThrough, removed, ops, archives } = snapshot;
  const body = { format, source, vector, maxLamport, compactedThrough, removed, ops, archives };
  return sha256Hex(toCanonical(body as unknown as JsonValue));
}

/** Adds the hash. */
export async function sealSnapshot(snapshot: Unhashed): Promise<Snapshot> {
  return { ...snapshot, hash: await hashSnapshot(snapshot) };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isVector(v: unknown): v is VersionVector {
  return (
    isObject(v) &&
    Object.values(v).every((s) => typeof s === 'number' && Number.isSafeInteger(s) && s >= 0)
  );
}

/**
 * Structural and integrity check without application knowledge: shape, hash, every op line
 * verified (D2 hash, canonical form, value rules), and the op lines are exactly the vector's
 * promise: for each origin every `seq` in `(compactedThrough, vector]` is present, none is above
 * `vector`, and none is duplicated. Returns the verified ops.
 */
export async function verifySnapshotEnvelope(
  value: unknown,
  options: { maxOpBytes?: number } = {},
): Promise<{
  /** The snapshot, with normalized vectors. */
  snapshot: Snapshot;
  /** Its op lines, verified and parsed, in the snapshot's order. */
  ops: Op[];
}> {
  if (!isObject(value)) invalid('not an object');
  if (value['format'] !== SNAPSHOT_FORMAT) invalid('unknown format', { format: value['format'] });
  if (typeof value['source'] !== 'string') invalid('source');
  if (!isVector(value['vector'])) invalid('vector');
  if (!isVector(value['compactedThrough'])) invalid('compactedThrough');
  if (!isVector(value['removed'])) invalid('removed');
  const maxLamport = value['maxLamport'];
  if (typeof maxLamport !== 'number' || !Number.isSafeInteger(maxLamport) || maxLamport < 0)
    invalid('maxLamport');
  if (!Array.isArray(value['ops']) || !value['ops'].every((l) => typeof l === 'string'))
    invalid('ops');
  const archives = value['archives'];
  if (
    !Array.isArray(archives) ||
    !archives.every(
      (a) =>
        Array.isArray(a) &&
        a.length === 3 &&
        typeof a[0] === 'string' &&
        typeof a[1] === 'string' &&
        Array.isArray(a[2]),
    )
  )
    invalid('archives');
  if (typeof value['hash'] !== 'string') invalid('hash');
  const snapshot = value as unknown as Snapshot;
  if ((await hashSnapshot(snapshot)) !== snapshot.hash) {
    throw new WeaveError('INTEGRITY_CONFLICT', 'The snapshot hash does not match its contents', {
      details: { status: 'SNAPSHOT_HASH_MISMATCH' },
    });
  }

  const ops: Op[] = [];
  const seen = new Set<string>();
  const perOrigin = new Map<string, number[]>();
  let lamport = 0;
  for (const line of snapshot.ops) {
    const op = await verifyOpLine(line, options);
    const key = `${op.replicaId}:${op.seq}`;
    if (seen.has(key)) invalid('duplicate op', { opId: key });
    seen.add(key);
    if (op.seq > (snapshot.vector[op.replicaId] ?? 0))
      invalid('op above the vector', { opId: key });
    perOrigin.set(op.replicaId, [...(perOrigin.get(op.replicaId) ?? []), op.seq]);
    lamport = Math.max(lamport, op.lamport);
    ops.push(op);
  }
  for (const [origin, top] of Object.entries(snapshot.vector)) {
    const from = (snapshot.compactedThrough[origin] ?? 0) + 1;
    if (from > top + 1) invalid('compactedThrough above the vector', { origin });
    const held = new Set(perOrigin.get(origin) ?? []);
    for (let seq = from; seq <= top; seq++)
      if (!held.has(seq)) invalid('missing op below the vector', { opId: `${origin}:${seq}` });
  }
  for (const origin of Object.keys(snapshot.compactedThrough))
    if ((snapshot.compactedThrough[origin] ?? 0) > (snapshot.vector[origin] ?? 0))
      invalid('compactedThrough above the vector', { origin });
  if (lamport > snapshot.maxLamport) invalid('maxLamport below an op', { lamport });
  return {
    snapshot: {
      ...snapshot,
      vector: normalizeVector(snapshot.vector),
      compactedThrough: normalizeVector(snapshot.compactedThrough),
    },
    ops,
  };
}

/**
 * True when `snapshot` can bootstrap a replica that then syncs with an endpoint which discarded
 * history through `compactedThrough`: the snapshot must hold every origin at least that far.
 */
export function coversCompacted(
  snapshot: Pick<Snapshot, 'vector'>,
  compactedThrough: VersionVector,
): boolean {
  return Object.entries(compactedThrough).every(([o, s]) => (snapshot.vector[o] ?? 0) >= s);
}
