/**
 * [ADV] Record existence with `restore` and the `update-wins` policy (D6, R6.9). Pure functions of
 * the op set of ONE record and the collection's delete options: arrival order never matters and
 * nothing outside the ops is read.
 *
 * - A delete D is cancelled by a restore R when D happens-before R.
 * - Under `update-wins`, a delete D is also ignored when some `set` op is concurrent with D.
 * - A record is deleted if and only if at least one delete is neither cancelled nor ignored.
 *
 * A restore concurrent with a delete does not cancel it. Without `deletes` options and without
 * restore ops this is exactly the 0.1.0 rule: a record with any delete op is deleted.
 */
import type { Op } from '../contracts/op.js';
import type { CollectionDefinition } from '../contracts/schema.js';
import { compareD4, happensBefore, isConcurrent } from '../ops/order.js';

/**
 * The delete ops that no restore op cancels (D6), in D4 order. Restore ops count only when the
 * collection enables restore; the engine never accepts them otherwise.
 */
export function uncancelledDeletes(
  ops: readonly Op[],
  definition: Pick<CollectionDefinition, 'deletes'>,
): Op[] {
  const restores = restoreEnabled(definition) ? ops.filter((o) => o.kind === 'restore') : [];
  return ops
    .filter((o) => o.kind === 'delete' && !restores.some((r) => happensBefore(o, r)))
    .sort(compareD4);
}

/** The delete ops that make the record deleted under the collection's policy (D6), in D4 order. */
export function effectiveDeletes(
  ops: readonly Op[],
  definition: Pick<CollectionDefinition, 'deletes'>,
): Op[] {
  const live = uncancelledDeletes(ops, definition);
  if (definition.deletes?.policy !== 'update-wins') return live;
  const sets = ops.filter((o) => o.kind === 'set');
  return live.filter((d) => !sets.some((s) => isConcurrent(d, s)));
}

/** D6: whether the record is deleted. */
export function isDeleted(
  ops: readonly Op[],
  definition: Pick<CollectionDefinition, 'deletes'>,
): boolean {
  return effectiveDeletes(ops, definition).length > 0;
}

/** Whether the collection accepts `restore` ops (R6.9). */
export function restoreEnabled(definition: Pick<CollectionDefinition, 'deletes'>): boolean {
  return definition.deletes?.restore === true;
}
