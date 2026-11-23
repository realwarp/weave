/**
 * Record operation history (R2.5, design 6.0): every accepted op of one record in D4 order, each
 * with the IDs of the other ops of that record that are concurrent with it. A pure function of the
 * op set; no transitivity is assumed.
 */
import type { Op, OpHistoryEntry } from '../contracts/op.js';
import { compareD4, isConcurrent, toOpId } from '../ops/order.js';

export function buildOpHistory(ops: readonly Op[]): OpHistoryEntry[] {
  const sorted = [...ops].sort(compareD4);
  return sorted.map((op) => {
    const entry: OpHistoryEntry = {
      opId: toOpId(op),
      kind: op.kind,
      lamport: op.lamport,
      schemaVersion: op.schemaVersion,
      fields: op.fields,
      context: op.context,
      concurrentWith: sorted.filter((other) => isConcurrent(op, other)).map(toOpId),
    };
    return op.wallTime === undefined ? entry : { ...entry, wallTime: op.wallTime };
  });
}
