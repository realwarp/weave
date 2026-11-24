/**
 * Compaction helpers for RelayCore (design 10.3).
 */
import { normalizeVector } from '@weave/core/protocol';
import type { ReplicaId, VersionVector } from '@weave/core/protocol';

export interface CompactionState {
  readonly horizon: VersionVector;
  readonly compactedThrough: VersionVector;
  readonly removed: Readonly<Record<ReplicaId, number>>;
}

/** Compute the horizon: for each origin, min(relayVector[o], min over NON-removed members of ack[o]). */
export function computeHorizon(
  relayVector: VersionVector,
  members: Map<ReplicaId, VersionVector>,
  removed: Readonly<Record<ReplicaId, number>>,
): VersionVector {
  const result: Record<string, number> = {};

  for (const origin of Object.keys(relayVector)) {
    const relayVal = relayVector[origin]!;
    const acks: number[] = [];

    for (const [memberId, ackVector] of members) {
      if (removed[memberId] === undefined) {
        const ackVal = ackVector[origin] ?? 0;
        acks.push(ackVal);
      }
    }

    if (acks.length === 0) {
      // No non-removed members: horizon is 0 for this origin
      result[origin] = 0;
    } else {
      const minAck = Math.min(...acks);
      result[origin] = Math.min(relayVal, minAck);
    }
  }

  return normalizeVector(result);
}
