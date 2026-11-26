/**
 * [ADV] Relay-side snapshots (R4.8). The relay stores one snapshot uploaded by a member and serves
 * it to new or rejoining replicas. It stays opaque: it checks the snapshot's hash, every op line
 * (structure, value rules, canonical form, D2 hash) and that the op lines match the vectors, but
 * never derives state or reads field values. The importing replica re-derives everything.
 */
import {
  WeaveError,
  coversCompacted,
  verifySnapshotEnvelope,
  type Snapshot,
  type StorageTx,
  type VersionVector,
} from '@weave/core/protocol';

/** Storage key of the relay's current snapshot. */
export const SNAPSHOT_KEY = 'meta/snapshot';

/** Default upper bound of an uploaded snapshot (bytes of JSON). */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export async function readSnapshot(tx: StorageTx): Promise<Snapshot | undefined> {
  const text = await tx.get(SNAPSHOT_KEY);
  return text === undefined ? undefined : (JSON.parse(text) as Snapshot);
}

/**
 * Verifies an uploaded snapshot for the relay. It must be intact and must cover everything the
 * relay discarded, or a replica bootstrapped from it could not continue syncing with this relay.
 */
export async function checkUpload(
  value: unknown,
  compactedThrough: VersionVector,
  maxOpBytes: number,
): Promise<Snapshot> {
  const { snapshot } = await verifySnapshotEnvelope(value, { maxOpBytes });
  if (!coversCompacted(snapshot, compactedThrough)) {
    throw new WeaveError(
      'VALIDATION_FAILED',
      'The snapshot does not cover the history this relay discarded',
      {
        details: { compactedThrough, snapshotVector: snapshot.vector },
      },
    );
  }
  return snapshot;
}

/** A newer upload replaces the stored snapshot only when it holds at least as much. */
export function supersedes(next: Snapshot, current: Snapshot | undefined): boolean {
  if (current === undefined) return true;
  return Object.entries(current.vector).every(([o, s]) => (next.vector[o] ?? 0) >= s);
}
