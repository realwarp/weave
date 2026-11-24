import type { JsonValue, OpId, ReplicaId } from './json.js';

/**
 * One frontier op of a field, as seen by a resolver (design 5.2).
 */
export interface FrontierEntry<V = JsonValue> {
  /** The identity of this operation. */
  readonly opId: OpId;
  /** The Lamport timestamp of this operation. */
  readonly lamport: number;
  /** The replica that created this operation. */
  readonly replicaId: ReplicaId;
  /** The sequence number of this operation within its replica. */
  readonly seq: number;
  /** The value of this field from this operation. */
  readonly value: V;
}

/**
 * Additional context passed to resolvers. Only `rankMap` is currently used.
 */
export interface ResolverContext<V = JsonValue> {
  /** Ordered list of allowed values; only for `max-rank`. */
  readonly rankMap?: readonly V[];
}

/**
 * A resolver is a pure function of the multiset of frontier entries. It MUST NOT depend on array
 * position, wall-clock time, randomness or any outside state (R6.6).
 */
export type Resolver<V = JsonValue> = (
  entries: readonly FrontierEntry<V>[],
  context: ResolverContext<V>,
) => V;

/**
 * Resolver names. [ADV] (0.2.0): `counter` (sum of per-replica deltas, `f.counter()`) and
 * `custom` (a field built with `f.custom()`, which carries its own `CustomResolver`).
 */
export type ResolverName =
  'last-writer-wins' | 'max' | 'min' | 'set-union' | 'max-rank' | 'counter' | 'custom';

/**
 * [ADV] A named custom resolver (R6.10), made with `defineResolver`. Every replica of a
 * collection must use the same resolver code under the same name. It must be pure and satisfy
 * R6.6; check it with `assertResolverDeterministic` in tests.
 */
export interface CustomResolver<V = JsonValue> {
  /** A stable name, `[a-z][a-z0-9-]{0,63}`; shown in errors. */
  readonly name: string;
  /** The resolver function. */
  readonly resolve: Resolver<V>;
}
