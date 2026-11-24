/**
 * [ADV] Held newer-schema ops (R8.7, task T5.5). With `holdNewerSchema`, a replica accepts ops it
 * cannot read yet (a collection it does not define, or a newer `schemaVersion`) instead of
 * blocking their origin. Held ops are ACCEPTED: stored in `op/` and `rop/`, counted in the vector,
 * the op-set hash and acknowledgements, and served to peers. They are excluded from derived state
 * until the app is upgraded; then they are validated against the new schema (phase A2 rules) and
 * the affected records are re-derived.
 *
 * A `held/<origin>/<seq>` entry (`HeldEntry`) marks each held op so that `status()` can report that
 * an update is needed without reading the op log. The marker of an op that becomes readable and
 * valid is removed. An op that becomes readable but fails validation stays excluded from state
 * for good and keeps its marker with `invalid: true` (its writer was faulty).
 */
import { WeaveError } from '../contracts/errors.js';
import type { Op } from '../contracts/op.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import { padSeq, type StorageTx } from '../contracts/storage.js';
import type { HeldStatus } from '../contracts/replica.js';
import { migrateAndCheck } from '../schema/index.js';
import { restoreEnabled } from '../state/restore.js';

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
  /** Set when the op became readable but failed validation; it never enters state. */
  readonly invalid?: true;
}

type Definitions = ReadonlyMap<string, CollectionDefinition>;

/** `origin:seq` of an op; the identity used by the invalid set. */
export const opKey = (op: Pick<Op, 'replicaId' | 'seq'>): string => `${op.replicaId}:${op.seq}`;

/** The `origin:seq` identity encoded in a held marker key. */
export function keyOfMarker(markerKey: string): string {
  const [, origin, seq] = markerKey.split('/') as [string, string, string];
  return `${origin}:${Number(seq)}`;
}

/** Whether this replica can read `op` (its collection is defined at a version it supports). */
export function isReadable(
  op: Pick<Op, 'collection' | 'schemaVersion'>,
  definitions: Definitions,
): boolean {
  const d = definitions.get(op.collection);
  return d !== undefined && op.schemaVersion <= d.version;
}

/**
 * The ops of one record that derived state uses: readable by this code and not marked invalid.
 * Without held ops this is every op.
 */
export function readableOps(
  ops: readonly Op[],
  definition: CollectionDefinition,
  invalid: ReadonlySet<string> = new Set(),
): Op[] {
  return ops.filter((o) => o.schemaVersion <= definition.version && !invalid.has(opKey(o)));
}

/**
 * Phase A2 for an op that was held and is now readable: the fields after migration must match
 * the schema, and a restore needs a collection that enables it.
 */
export function heldOpIsValid(op: Op, definition: CollectionDefinition): boolean {
  try {
    if (op.kind === 'restore') return restoreEnabled(definition);
    if (op.kind === 'set')
      migrateAndCheck(definition, {
        fields: op.fields,
        recordId: op.recordId,
        fromVersion: op.schemaVersion,
      });
    return true;
  } catch (e) {
    if (e instanceof WeaveError) return false;
    throw e;
  }
}

/** Reads every held marker. */
export async function readHeld(tx: StorageTx): Promise<Array<{ key: string; entry: HeldEntry }>> {
  return (await tx.scan(HELD_PREFIX)).map(([key, text]) => ({
    key,
    entry: JSON.parse(text) as HeldEntry,
  }));
}

/**
 * The status report: held ops this code cannot read yet (their number and, per collection, the
 * highest schema version they need), plus ops that failed validation after an upgrade.
 * `undefined` when there is neither.
 */
export function summarizeHeld(
  entries: ReadonlyArray<{ entry: HeldEntry }>,
  definitions: Definitions,
): HeldStatus | undefined {
  const needs: Record<string, number> = {};
  let ops = 0;
  let invalid = 0;
  for (const { entry } of entries) {
    if (entry.invalid === true) {
      invalid++;
      continue;
    }
    if (isReadable(entry, definitions)) continue;
    ops++;
    needs[entry.collection] = Math.max(needs[entry.collection] ?? 0, entry.schemaVersion);
  }
  if (ops === 0 && invalid === 0) return undefined;
  const sorted: Record<string, number> = {};
  for (const name of Object.keys(needs).sort()) sorted[name] = needs[name]!;
  return { ops, needs: sorted, ...(invalid === 0 ? {} : { invalid }) };
}
