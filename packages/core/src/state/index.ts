import type { Op } from '../contracts/op.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import type { ConflictRecord, DerivedRecord } from '../contracts/state.js';
import { deriveState } from './derive.js';
import { replayConflicts } from './history.js';

export { buildOpHistory } from './opHistory.js';
export { deriveState, frontierOf, type DerivedState } from './derive.js';
export { replayConflicts } from './history.js';

/**
 * The full materialized record (design 3.4, 6, 6.1): derived state, current conflicts, and every
 * conflict ID of the history log (open and superseded), so that a conflict created and superseded
 * inside one batch is still known for notification recovery.
 */
export async function deriveRecord(
  ops: readonly Op[],
  definition: CollectionDefinition,
  collection: string,
  recordId: string,
): Promise<DerivedRecord> {
  const state = await deriveState(ops, definition, collection, recordId);
  const history = await replayConflicts(
    ops,
    definition,
    collection,
    recordId,
    new Set(state.conflicts.map((c) => c.conflictId)),
  );
  return {
    deleted: state.deleted,
    fields: state.fields,
    conflicts: state.conflicts,
    conflictHistoryIds: [...new Set(history.map((c) => c.conflictId))].sort(),
  };
}

/** The history log of one record, with open/superseded status (D8). */
export async function conflictHistory(
  ops: readonly Op[],
  definition: CollectionDefinition,
  collection: string,
  recordId: string,
): Promise<ConflictRecord[]> {
  const state = await deriveState(ops, definition, collection, recordId);
  return replayConflicts(
    ops,
    definition,
    collection,
    recordId,
    new Set(state.conflicts.map((c) => c.conflictId)),
  );
}
