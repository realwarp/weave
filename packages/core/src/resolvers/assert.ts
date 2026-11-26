/**
 * [ADV] `assertResolverDeterministic` (R6.10, R6.6, task T5.4): a test helper that calls a resolver
 * directly with every order of each sample frontier (or a fixed set of seeded orders for large
 * samples) and requires the same canonical result every time. Inputs are deep-frozen copies, so a
 * resolver that mutates its input fails too. It reads no clock and no randomness.
 */
import { assertSupported, encodeCanonical } from '../canonical/encode.js';
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type {
  CustomResolver,
  FrontierEntry,
  Resolver,
  ResolverContext,
} from '../contracts/resolver.js';

/** Options of `assertResolverDeterministic`. */
export interface AssertResolverOptions {
  /** Context passed to every call (for example a `rankMap`). */
  readonly context?: ResolverContext;
  /** Orders tried per sample with more than 6 entries (default 200). Smaller samples try all. */
  readonly orders?: number;
}

function deepFrozenCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const copy = (
    Array.isArray(value)
      ? value.map(deepFrozenCopy)
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFrozenCopy(v)]))
  ) as T;
  return Object.freeze(copy);
}

function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  const out: T[][] = [];
  list.forEach((item, i) => {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)]))
      out.push([item, ...rest]);
  });
  return out;
}

/** Deterministic shuffles from a linear congruential generator (no `Math.random`). */
function seededOrders<T>(list: readonly T[], count: number): T[][] {
  const out: T[][] = [[...list], [...list].reverse()];
  let x = 0x2545f491;
  for (let s = 0; out.length < count; s++) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      x = (Math.imul(x, 1103515245) + 12345 + s) >>> 0;
      const j = x % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    out.push(copy);
  }
  return out;
}

type Outcome = { ok: true; encoded: string } | { ok: false; error: string };

function run(resolve: Resolver, entries: FrontierEntry[], context: ResolverContext): Outcome {
  try {
    // A frozen array of frozen entries: sorting or editing the input throws.
    const value = resolve(Object.freeze([...entries]), context);
    assertSupported(value);
    return { ok: true, encoded: encodeCanonical(value) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof WeaveError ? e.code : e instanceof Error ? e.name : 'thrown value',
    };
  }
}

/**
 * Checks that a resolver gives the same result for every order of each sample (R6.6).
 * @param resolver A resolver function or a custom resolver from `defineResolver`.
 * @param samples Frontiers to try; each is a list of entries with distinct op IDs.
 * @param options Context and the number of orders for large samples.
 * @throws RESOLVER_ERROR naming the sample and the first order that disagrees.
 */
export function assertResolverDeterministic<V = JsonValue>(
  resolver: Resolver<V> | CustomResolver<V>,
  samples: readonly (readonly FrontierEntry<NoInfer<V>>[])[],
  options: AssertResolverOptions = {},
): void {
  const resolve = (typeof resolver === 'function'
    ? resolver
    : resolver.resolve) as unknown as Resolver;
  const name = typeof resolver === 'function' ? 'resolver' : `resolver "${resolver.name}"`;
  const context = deepFrozenCopy(options.context ?? {});
  if (samples.length === 0)
    throw new WeaveError('VALIDATION_FAILED', 'assertResolverDeterministic needs samples');
  samples.forEach((sample, index) => {
    const frozen = sample.map(deepFrozenCopy) as unknown as FrontierEntry[];
    const orders =
      frozen.length <= 6 ? permutations(frozen) : seededOrders(frozen, options.orders ?? 200);
    const reference = run(resolve, [...frozen], context);
    if (!reference.ok) {
      throw new WeaveError('RESOLVER_ERROR', `${name} failed on sample ${index}`, {
        details: { sample: index, error: reference.error },
      });
    }
    for (const order of [...orders, [...frozen]]) {
      const outcome = run(resolve, order, context);
      if (!outcome.ok || outcome.encoded !== reference.encoded) {
        throw new WeaveError('RESOLVER_ERROR', `${name} is not deterministic (R6.6)`, {
          details: {
            sample: index,
            order: order.map((e) => `${e.opId.replicaId}:${e.opId.seq}`),
            expected: reference,
            actual: outcome,
          },
        });
      }
    }
  });
}
