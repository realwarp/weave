import type { JsonValue, OpId, ReplicaId } from './json.js';

/** One frontier op of a field, as seen by a resolver (design 5.2). */
export interface FrontierEntry<V = JsonValue> {
  readonly opId: OpId;
  readonly lamport: number;
  readonly replicaId: ReplicaId;
  readonly seq: number;
  readonly value: V;
}

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
