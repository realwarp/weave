/**
 * Conflict history log (D8, design 6.1): replay the record's ops in D4 order and note every
 * frontier of two or more ops (and every delete group) that appears. A D4 prefix is causally
 * closed (A happens-before B implies lamport(A) < lamport(B)), so each prefix is a valid op set.
 * The log is a pure function of the op set: equal op sets give equal logs.
 */
import type { JsonValue } from '../contracts/json.js';
import type { Op } from '../contracts/op.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import type { ConflictRecord } from '../contracts/state.js';
import { compareD4, opIdKey, toOpId } from '../ops/order.js';
import {
  deleteConflictId,
  deleteGroups,
  fieldConflictId,
  frontierOf,
  migratedSetOps,
  resolveWrites,
  toEntries,
  type FieldWrite,
} from './derive.js';

export async function replayConflicts(
  ops: readonly Op[],
  definition: CollectionDefinition,
  collection: string,
  recordId: string,
  openIds: ReadonlySet<string>,
): Promise<ConflictRecord[]> {
  const sorted = [...ops].sort(compareD4);
  const migrated = new Map(migratedSetOps(sorted, definition).map((m) => [m.op, m.fields]));
  const writes = new Map<string, FieldWrite[]>();
  const prefix: Op[] = [];
  const seen = new Set<string>();
  const out: ConflictRecord[] = [];
  const status = (id: string): 'open' | 'superseded' => (openIds.has(id) ? 'open' : 'superseded');

  for (const op of sorted) {
    prefix.push(op);
    const fields = migrated.get(op);
    if (fields !== undefined) {
      for (const [field, value] of Object.entries(fields)) {
        const list = [...(writes.get(field) ?? []), { op, value }];
        writes.set(field, list);
        const frontier = frontierOf(list);
        if (frontier.length < 2) continue;
        const key = `f|${field}|${frontier
          .map((w) => opIdKey(w.op))
          .sort()
          .join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const id = await fieldConflictId(
          collection,
          recordId,
          field,
          frontier.map((w) => w.op),
        );
        const entries = toEntries(frontier);
        out.push({
          conflictId: id,
          kind: 'field',
          collection,
          recordId,
          field,
          frontier: entries.map((e) => ({ opId: e.opId, value: e.value as JsonValue })),
          resolved: resolveWrites(definition, field, frontier),
          status: status(id),
        });
      }
    }
    for (const group of deleteGroups(prefix)) {
      const groupOps = [group.del, ...group.concurrent];
      const key = `d|${groupOps.map(opIdKey).sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = await deleteConflictId(collection, recordId, groupOps);
      out.push({
        conflictId: id,
        kind: 'delete',
        collection,
        recordId,
        frontier: [...groupOps].sort(compareD4).map((o) => ({ opId: toOpId(o) })),
        status: status(id),
      });
    }
  }
  return out;
}
