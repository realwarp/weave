/**
 * Version vectors (design 3.2). A vector maps an origin replica to the highest contiguous
 * ACCEPTED seq. Missing origins count as 0. Vectors built here never store zero entries.
 */
import type { OpId, ReplicaId, VersionVector } from '../contracts/json.js';

export function emptyVector(): VersionVector {
  return {};
}

export function vectorGet(vector: VersionVector, origin: ReplicaId): number {
  return vector[origin] ?? 0;
}

/** A copy with zero and missing entries removed and keys in sorted order. */
export function normalizeVector(vector: VersionVector): VersionVector {
  const out: Record<ReplicaId, number> = {};
  for (const origin of Object.keys(vector).sort()) {
    const seq = vector[origin] ?? 0;
    if (seq > 0) out[origin] = seq;
  }
  return out;
}

/** Returns a copy of `vector` with `origin` set to `seq`. */
export function withEntry(vector: VersionVector, origin: ReplicaId, seq: number): VersionVector {
  return normalizeVector({ ...vector, [origin]: seq });
}

/** Pointwise maximum. */
export function mergeVectors(...vectors: readonly VersionVector[]): VersionVector {
  const out: Record<ReplicaId, number> = {};
  for (const v of vectors) {
    for (const [origin, seq] of Object.entries(v)) {
      if (seq > (out[origin] ?? 0)) out[origin] = seq;
    }
  }
  return normalizeVector(out);
}

/** Pointwise minimum over the union of origins (missing counts as 0). */
export function minVectors(...vectors: readonly VersionVector[]): VersionVector {
  if (vectors.length === 0) return {};
  const origins = new Set(vectors.flatMap((v) => Object.keys(v)));
  const out: Record<ReplicaId, number> = {};
  for (const origin of origins) out[origin] = Math.min(...vectors.map((v) => v[origin] ?? 0));
  return normalizeVector(out);
}

/** True when the op is covered by (held in) the vector. */
export function vectorCovers(vector: VersionVector, opId: OpId): boolean {
  return (vector[opId.replicaId] ?? 0) >= opId.seq;
}

/** Equality treating missing entries as 0. */
export function vectorsEqual(a: VersionVector, b: VersionVector): boolean {
  const origins = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const origin of origins) if ((a[origin] ?? 0) !== (b[origin] ?? 0)) return false;
  return true;
}

/** True when `a` covers everything `b` covers. */
export function vectorDominates(a: VersionVector, b: VersionVector): boolean {
  for (const [origin, seq] of Object.entries(b)) if ((a[origin] ?? 0) < seq) return false;
  return true;
}

/** 'equal', 'before' (a < b), 'after' (a > b) or 'concurrent'. */
export function compareVectors(
  a: VersionVector,
  b: VersionVector,
): 'equal' | 'before' | 'after' | 'concurrent' {
  const ab = vectorDominates(a, b);
  const ba = vectorDominates(b, a);
  if (ab && ba) return 'equal';
  if (ab) return 'after';
  if (ba) return 'before';
  return 'concurrent';
}

/** Number of ops that `a` holds and `b` does not. */
export function vectorDifference(a: VersionVector, b: VersionVector): number {
  let n = 0;
  for (const [origin, seq] of Object.entries(a)) n += Math.max(0, seq - (b[origin] ?? 0));
  return n;
}
