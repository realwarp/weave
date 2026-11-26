/**
 * State derivation (D5, D6, D8, design 6). Pure functions of the accepted op set of ONE record:
 * the arrival order never matters, and nothing outside the ops is read.
 *
 * Frontier of a field: the ops that set it and are not covered by the context of another op that
 * sets the same field. Computed directly from each op's full context (no transitivity assumed).
 */
import { hashOfCanonical } from '../canonical/hash.js';
import type { JsonValue, OpId } from '../contracts/json.js';
import type { Op } from '../contracts/op.js';
import type { FrontierEntry } from '../contracts/resolver.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import type { ConflictRecord } from '../contracts/state.js';
import { compareD4, happensBefore, isConcurrent, opIdKey, toOpId } from '../ops/order.js';
import { WeaveError } from '../contracts/errors.js';
import { runCustom } from '../resolvers/custom.js';
import { getResolver } from '../resolvers/index.js';
import { migrateFields } from '../schema/index.js';
import { isDeleted, uncancelledDeletes } from './restore.js';

export interface FieldWrite {
  readonly op: Op;
  readonly value: JsonValue;
}

/** Each set op with its fields migrated to the current schema version. */
export function migratedSetOps(
  ops: readonly Op[],
  definition: CollectionDefinition,
): Array<{ op: Op; fields: Readonly<Record<string, JsonValue>> }> {
  return ops
    .filter((op) => op.kind === 'set')
    .map((op) => ({
      op,
      fields:
        op.schemaVersion === definition.version
          ? op.fields
          : migrateFields(definition, {
              fields: op.fields,
              recordId: op.recordId,
              fromVersion: op.schemaVersion,
            }),
    }));
}

/** D5: the writes of a field that no other write of the same field causally follows. */
export function frontierOf(writes: readonly FieldWrite[]): FieldWrite[] {
  return writes.filter((a) => !writes.some((b) => b.op !== a.op && happensBefore(a.op, b.op)));
}

export function toEntries(writes: readonly FieldWrite[]): FrontierEntry[] {
  return [...writes]
    .sort((a, b) => compareD4(a.op, b.op))
    .map((w) => ({
      opId: toOpId(w.op),
      lamport: w.op.lamport,
      replicaId: w.op.replicaId,
      seq: w.op.seq,
      value: w.value,
    }));
}

export function resolveWrites(
  definition: CollectionDefinition,
  field: string,
  writes: readonly FieldWrite[],
): JsonValue {
  const spec = definition.fields[field];
  const name = spec?.resolver ?? 'last-writer-wins';
  const context =
    spec?.rankMap === undefined ? {} : { rankMap: spec.rankMap as readonly JsonValue[] };
  // [ADV] A custom field carries its own resolver; its result is checked (R6.10).
  if (name === 'custom') {
    if (spec?.custom === undefined)
      throw new WeaveError('RESOLVER_ERROR', `Field "${field}" has no custom resolver`);
    return runCustom(spec.custom, toEntries(writes), context, (v) => spec.validate(v));
  }
  return getResolver(name)(toEntries(writes), context);
}

function sortedIds(ops: readonly Op[]): string[] {
  return [...ops].sort(compareD4).map(opIdKey);
}

export function fieldConflictId(
  collection: string,
  recordId: string,
  field: string,
  ops: readonly Op[],
): Promise<string> {
  return hashOfCanonical([collection, recordId, 'field', field, sortedIds(ops)]);
}

export function deleteConflictId(
  collection: string,
  recordId: string,
  ops: readonly Op[],
): Promise<string> {
  return hashOfCanonical([collection, recordId, 'delete', sortedIds(ops)]);
}

/** For each delete op, the set ops concurrent with it (D6, D8). Only non-empty groups. */
export function deleteGroups(ops: readonly Op[]): Array<{ del: Op; concurrent: Op[] }> {
  const sets = ops.filter((o) => o.kind === 'set');
  return ops
    .filter((o) => o.kind === 'delete')
    .sort(compareD4)
    .map((del) => ({ del, concurrent: sets.filter((s) => isConcurrent(del, s)).sort(compareD4) }))
    .filter((g) => g.concurrent.length > 0);
}

export interface DerivedState {
  readonly deleted: boolean;
  readonly fields: Readonly<
    Record<string, { readonly value: JsonValue; readonly frontier: readonly OpId[] }>
  >;
  readonly conflicts: ConflictRecord[];
}

/**
 * Steps 1 to 8 of design 6: delete rule, migration, frontier per field, resolution, and the
 * current field and delete conflicts.
 */
export async function deriveState(
  ops: readonly Op[],
  definition: CollectionDefinition,
  collection: string,
  recordId: string,
): Promise<DerivedState> {
  const sorted = [...ops].sort(compareD4);
  // Step 2 (D6): with no `deletes` options and no restore ops, any delete op deletes the record.
  const deleted = isDeleted(sorted, definition);
  // A delete that a restore cancelled no longer conflicts with anything; it stays in history.
  const restored = new Set(sorted.filter((o) => o.kind === 'delete').map(opIdKey));
  for (const d of uncancelledDeletes(sorted, definition)) restored.delete(opIdKey(d));
  const byField = new Map<string, FieldWrite[]>();
  for (const { op, fields } of migratedSetOps(sorted, definition)) {
    for (const [field, value] of Object.entries(fields)) {
      byField.set(field, [...(byField.get(field) ?? []), { op, value }]);
    }
  }
  const resolved: Record<string, { value: JsonValue; frontier: OpId[] }> = {};
  const conflicts: ConflictRecord[] = [];
  for (const field of [...byField.keys()].sort()) {
    const frontier = frontierOf(byField.get(field)!);
    const value = resolveWrites(definition, field, frontier);
    const entries = toEntries(frontier);
    resolved[field] = { value, frontier: entries.map((e) => e.opId) };
    if (frontier.length >= 2) {
      conflicts.push({
        conflictId: await fieldConflictId(
          collection,
          recordId,
          field,
          frontier.map((w) => w.op),
        ),
        kind: 'field',
        collection,
        recordId,
        field,
        frontier: entries.map((e) => ({ opId: e.opId, value: e.value })),
        resolved: value,
        status: 'open',
      });
    }
  }
  for (const group of deleteGroups(sorted)) {
    if (restored.has(opIdKey(group.del))) continue;
    const groupOps = [group.del, ...group.concurrent];
    conflicts.push({
      conflictId: await deleteConflictId(collection, recordId, groupOps),
      kind: 'delete',
      collection,
      recordId,
      frontier: [...groupOps].sort(compareD4).map((o) => ({ opId: toOpId(o) })),
      status: 'open',
    });
  }
  conflicts.sort((a, b) =>
    a.conflictId < b.conflictId ? -1 : a.conflictId > b.conflictId ? 1 : 0,
  );
  return { deleted, fields: deleted ? {} : resolved, conflicts };
}
