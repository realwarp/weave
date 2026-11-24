/**
 * [ADV] Held newer-schema ops (R8.7, task T5.5). With `holdNewerSchema`, a replica accepts ops it
 * cannot read yet (a collection it does not define, or a newer `schemaVersion`) instead of
 * blocking their origin. Held ops are ACCEPTED: stored in `op/` and `rop/`, counted in the vector,
 * the op-set hash and acknowledgements, and served to peers. They are excluded from derived state
 * until the app is upgraded; then the affected records are re-derived from all their ops.
 *
 * A `held/<origin>/<seq>` entry (`HeldEntry`) marks each held op so that `status()` can report that
 * an update is needed without reading the op log. Entries are removed when the op becomes readable.
 */
import type { Op } from '../contracts/op.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import { padSeq, type StorageTx } from '../contracts/storage.js';
import type { HeldStatus } from '../contracts/replica.js';

/** Key of the held marker of one op. */
export const heldKey = (origin: string, seq: number): string => `held/${origin}/${padSeq(seq)}`;
/** Prefix of every held marker. */
export const HELD_PREFIX = 'held/';

/** Value stored at `held/<origin>/<seq>`. */
export interface HeldEntry {
  /** The op's collection. */
  readonly collection: string;
  /** The schema version the op needs. */
  readonly schemaVersion: number;
}

type Definitions = ReadonlyMap<string, CollectionDefinition>;

/** Whether this replica can read `op` (its collection is defined at a version it supports). */
export function isReadable(
  op: Pick<Op, 'collection' | 'schemaVersion'>,
  definitions: Definitions,
): boolean {
  const d = definitions.get(op.collection);
  return d !== undefined && op.schemaVersion <= d.version;
}

/** The ops of one record that this replica can read; derived state uses only these. */
export function readableOps(ops: readonly Op[], definition: CollectionDefinition): Op[] {
  return ops.filter((o) => o.schemaVersion <= definition.version);
}

/** Reads every held marker. */
export async function readHeld(tx: StorageTx): Promise<Array<{ key: string; entry: HeldEntry }>> {
  return (await tx.scan(HELD_PREFIX)).map(([key, text]) => ({
    key,
    entry: JSON.parse(text) as HeldEntry,
  }));
}

/**
 * The status report for held ops that are still unreadable: their number and, per collection,
 * the highest schema version they need. `undefined` when no update is needed.
 */
export function summarizeHeld(
  entries: ReadonlyArray<{ entry: HeldEntry }>,
  definitions: Definitions,
): HeldStatus | undefined {
  const needs: Record<string, number> = {};
  let ops = 0;
  for (const { entry } of entries) {
    if (isReadable(entry, definitions)) continue;
    ops++;
    needs[entry.collection] = Math.max(needs[entry.collection] ?? 0, entry.schemaVersion);
  }
  if (ops === 0) return undefined;
  const sorted: Record<string, number> = {};
  for (const name of Object.keys(needs).sort()) sorted[name] = needs[name]!;
  return { ops, needs: sorted };
}
