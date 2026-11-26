/**
 * [ADV] Compaction planning (R3.6 to R3.10, R3.13, design 10.3, ADR-0006). Pure functions: the
 * engine reads the data, calls these, and commits the result in one transaction.
 *
 * Safety argument. An op is discarded only when (a) the horizon covers it, so every registered
 * member holds it and every future op of a member happens after it, and (b) the record derived from
 * the remaining ops is identical to the stored record. A frontier op is never discarded, so open
 * conflicts and resolved values stay. For a record whose delete op is covered, the set ops covered
 * by the horizon go and the delete ops stay as the compact tombstone (R3.13); a delete that the
 * horizon does not yet cover keeps the full tombstone.
 *
 * Compaction assumes members follow the acknowledgement protocol; it is not Byzantine-safe.
 */
import { WeaveError } from '../contracts/errors.js';
import type { ReplicaId, VersionVector } from '../contracts/json.js';
import type { Op } from '../contracts/op.js';
import type { ConflictRecord, DerivedRecord } from '../contracts/state.js';
import type { MetaCompaction } from '../contracts/storage.js';
import { minVectors, normalizeVector } from '../ops/vector.js';

/** Empty compaction state. */
export const EMPTY_COMPACTION: MetaCompaction = { horizon: {}, compactedThrough: {}, removed: {} };

/** True when the horizon covers the op. */
export function covered(horizon: VersionVector, op: Pick<Op, 'replicaId' | 'seq'>): boolean {
  return op.seq <= (horizon[op.replicaId] ?? 0);
}

/**
 * The horizon of a closed replica set (R3.6): the minimum of this replica's vector and the
 * acknowledged vector of every other listed, not removed member. A member that never acknowledged
 * counts as zero (R3.7), so nothing it may lack is discarded.
 */
export function closedSetHorizon(
  selfId: ReplicaId,
  selfVector: VersionVector,
  members: readonly ReplicaId[],
  acks: ReadonlyMap<ReplicaId, VersionVector>,
  removed: Readonly<Record<ReplicaId, number>>,
): VersionVector {
  const others = members.filter((m) => m !== selfId && removed[m] === undefined);
  const vectors = [selfVector, ...others.map((m) => acks.get(m) ?? {})];
  return capHorizon(minVectors(...vectors), selfVector);
}

/** A horizon never extends beyond what this replica holds. */
export function capHorizon(horizon: VersionVector, held: VersionVector): VersionVector {
  const out: Record<string, number> = {};
  for (const [origin, seq] of Object.entries(horizon))
    out[origin] = Math.min(seq, held[origin] ?? 0);
  return normalizeVector(out);
}

/** The visible parts of a record: compaction must leave them unchanged. */
function visible(record: DerivedRecord): string {
  return JSON.stringify({
    deleted: record.deleted,
    fields: record.fields,
    conflicts: record.conflicts,
  });
}

export interface RecordPlan {
  /** Ops to discard. Empty when the record cannot lose any op. */
  readonly remove: readonly Op[];
  /** The ops that stay. */
  readonly keep: readonly Op[];
}

/**
 * Plans one record. `derive` re-derives a record from a list of ops (the engine's own
 * derivation), so the check uses exactly the code that serves reads.
 */
export async function planRecord(
  ops: readonly Op[],
  stored: DerivedRecord,
  horizon: VersionVector,
  derive: (ops: readonly Op[]) => Promise<DerivedRecord>,
  options: {
    /**
     * [ADV] Keep every op of a deleted record (R6.9): with `restore` or `update-wins` a deleted
     * record can become live again, so a compact tombstone would make replicas diverge.
     */
    readonly keepTombstones?: boolean | undefined;
  } = {},
): Promise<RecordPlan> {
  const nothing = { remove: [], keep: ops };
  const deletes = ops.filter((o) => o.kind === 'delete');
  let remove: Op[];
  if (stored.deleted) {
    if (options.keepTombstones === true) return nothing;
    // Full tombstone until a delete op is covered; then the compact tombstone (R3.13). Delete and
    // restore ops always stay.
    if (!deletes.some((d) => covered(horizon, d))) return nothing;
    remove = ops.filter((o) => o.kind === 'set' && covered(horizon, o));
  } else {
    const frontier = new Set<string>();
    for (const field of Object.values(stored.fields))
      for (const id of field.frontier) frontier.add(`${id.replicaId}:${id.seq}`);
    remove = ops.filter((o) => covered(horizon, o) && !frontier.has(`${o.replicaId}:${o.seq}`));
  }
  if (remove.length === 0) return nothing;
  const gone = new Set(remove.map((o) => `${o.replicaId}:${o.seq}`));
  const keep = ops.filter((o) => !gone.has(`${o.replicaId}:${o.seq}`));
  if (keep.length === 0) return nothing;
  // Conservative: if anything visible would change, keep every op of this record.
  if (visible(await derive(keep)) !== visible(stored)) return nothing;
  return { remove, keep };
}

/** Raises `compactedThrough` to cover the discarded ops. */
export function advanceCompactedThrough(
  current: VersionVector,
  removed: readonly Op[],
): VersionVector {
  const out: Record<string, number> = { ...current };
  for (const op of removed) out[op.replicaId] = Math.max(out[op.replicaId] ?? 0, op.seq);
  return normalizeVector(out);
}

/** Conflict history to keep after compaction: the old archive plus the full replay, by ID. */
export function mergeArchive(
  archive: readonly ConflictRecord[],
  replay: readonly ConflictRecord[],
): ConflictRecord[] {
  const byId = new Map<string, ConflictRecord>();
  for (const c of archive) byId.set(c.conflictId, c);
  for (const c of replay) byId.set(c.conflictId, c);
  return [...byId.values()].sort((a, b) =>
    a.conflictId < b.conflictId ? -1 : a.conflictId > b.conflictId ? 1 : 0,
  );
}

/**
 * Refuses to serve history that was discarded (R3.9): a peer that asks for ops of `origin` after
 * `afterSeq` needs a snapshot when that range starts below `compactedThrough`.
 */
export function assertServable(
  compactedThrough: VersionVector,
  origin: ReplicaId,
  afterSeq: number,
): void {
  const through = compactedThrough[origin] ?? 0;
  if (afterSeq < through) {
    throw new WeaveError(
      'NEEDS_SNAPSHOT',
      'The requested history was compacted; bootstrap from a snapshot',
      {
        details: { origin, afterSeq, compactedThrough: through },
      },
    );
  }
}

/** Refuses ops a removed member wrote after its removal (R3.10). */
export function assertNotRemoved(
  removed: Readonly<Record<ReplicaId, number>>,
  op: Pick<Op, 'replicaId' | 'seq'>,
): void {
  const through = removed[op.replicaId];
  if (through !== undefined && op.seq > through) {
    throw new WeaveError('PEER_REMOVED', 'Ops from a removed member are refused', {
      details: { replicaId: op.replicaId, seq: op.seq, removedThrough: through },
    });
  }
}
