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

/** Built-in resolver names. `counter` and custom resolvers are [ADV]. */
export type ResolverName = 'last-writer-wins' | 'max' | 'min' | 'set-union' | 'max-rank';
