/**
 * [ADV] Counter resolver (R6.10, task T5.4): the sum of per-replica deltas.
 *
 * A counter field's op value is a counter state: for each replica that ever changed it, the total
 * of that replica's positive deltas and the total of its negative deltas, `{ [replicaId]: [p, n] }`.
 * Both totals only grow. A writer always starts from the merged state of every op it holds, so
 * the state of an op covers every op it causally follows; concurrent states merge by taking the
 * larger total per replica. The visible value is the sum of `p - n` over all replicas.
 *
 * Merging is commutative, associative and idempotent, so the result is a pure function of the
 * multiset of frontier entries (R6.6). Totals are safe integers and the sum is computed exactly.
 */
import { compareUtf8 } from '../canonical/encode.js';
import { WeaveError } from '../contracts/errors.js';
import type { Resolver } from '../contracts/resolver.js';
import { REPLICA_ID_PATTERN } from '../ops/random.js';

/** A counter state: per replica, the totals of its positive and negative deltas. */
export type CounterState = Readonly<Record<string, readonly [number, number]>>;

const isTotal = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Whether `value` is a well-formed counter state (the stored form of a counter field). */
export function isCounterState(value: unknown): value is CounterState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [replica, totals] of Object.entries(value)) {
    if (!REPLICA_ID_PATTERN.test(replica)) return false;
    if (!Array.isArray(totals) || totals.length !== 2) return false;
    if (!isTotal(totals[0]) || !isTotal(totals[1])) return false;
  }
  return true;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new WeaveError('RESOLVER_ERROR', message, { details });
}

/** Merges counter states: the larger total per replica and sign. Order does not matter. */
export function mergeCounterStates(states: readonly unknown[]): CounterState {
  const out: Record<string, [number, number]> = {};
  for (const state of states) {
    if (!isCounterState(state)) fail('counter: value is not a counter state', { value: state });
    const entries = Object.entries(state as CounterState);
    for (const [replica, [p, n]] of entries) {
      const cur = out[replica];
      out[replica] = cur === undefined ? [p, n] : [Math.max(cur[0], p), Math.max(cur[1], n)];
    }
  }
  const sorted: Record<string, readonly [number, number]> = {};
  for (const key of Object.keys(out).sort(compareUtf8)) sorted[key] = out[key]!;
  return sorted;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The visible value of a counter state: the sum of every replica's `p - n`. The sum is computed
 * exactly (as a `bigint`), so intermediate values beyond 2^53 cannot round, and the safe-integer
 * check applies to the exact result.
 */
export function counterTotal(state: CounterState): number {
  let sum = BigInt(0);
  for (const key of Object.keys(state).sort(compareUtf8)) {
    const [p, n] = state[key]!;
    sum += BigInt(p) - BigInt(n);
  }
  if (sum > MAX_SAFE || sum < -MAX_SAFE)
    fail('counter: the total is not a safe integer', { sum: sum.toString() });
  return Number(sum);
}

/**
 * Adds one replica's delta to a merged state. `delta` is a safe integer; it raises the writer's
 * positive or negative total.
 * @throws VALIDATION_FAILED if the delta or the new total is not a safe integer.
 */
export function applyCounterDelta(
  state: CounterState,
  replicaId: string,
  delta: number,
): CounterState {
  if (!Number.isSafeInteger(delta)) {
    throw new WeaveError('VALIDATION_FAILED', 'A counter delta must be a safe integer', {
      details: { delta },
    });
  }
  const [p, n] = state[replicaId] ?? [0, 0];
  const next: [number, number] = delta >= 0 ? [p + delta, n] : [p, n - delta];
  if (!Number.isSafeInteger(next[0]) || !Number.isSafeInteger(next[1])) {
    throw new WeaveError('VALIDATION_FAILED', 'The counter total would exceed a safe integer', {
      details: { delta },
    });
  }
  return mergeCounterStates([state, { [replicaId]: next }]);
}

/** The `counter` resolver: merge the frontier states and return their total (R6.10). */
export const counter: Resolver = (entries) => {
  if (entries.length === 0) fail('counter: the frontier is empty');
  return counterTotal(mergeCounterStates(entries.map((e) => e.value)));
};
