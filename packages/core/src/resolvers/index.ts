/**
 * Built-in resolvers (R6.3 to R6.6, design 5.2). Each is a pure function of the MULTISET of
 * frontier entries: none of them reads array positions, so any permutation gives the same value.
 */
import { compareUtf8, encodeCanonical } from '../canonical/encode.js';
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import type {
  FrontierEntry,
  Resolver,
  ResolverContext,
  ResolverName,
} from '../contracts/resolver.js';

import { counter } from './counter.js';

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new WeaveError('RESOLVER_ERROR', message, { details });
}

function requireEntries(entries: readonly FrontierEntry[], name: string): void {
  if (entries.length === 0) fail(`${name}: the frontier is empty`);
}

/** Greater D4 key wins: (lamport, replicaId by UTF-8 bytes, seq), compared explicitly. */
function d4Greater(a: FrontierEntry, b: FrontierEntry): boolean {
  if (a.lamport !== b.lamport) return a.lamport > b.lamport;
  const r = compareUtf8(a.replicaId, b.replicaId);
  if (r !== 0) return r > 0;
  return a.seq > b.seq;
}

export const lastWriterWins: Resolver = (entries) => {
  requireEntries(entries, 'last-writer-wins');
  let best = entries[0]!;
  for (const e of entries) if (d4Greater(e, best)) best = e;
  return best.value;
};

type Scalar = { kind: 'number'; value: number } | { kind: 'string'; value: string };

function scalars(entries: readonly FrontierEntry[], name: string): Scalar[] {
  requireEntries(entries, name);
  const out: Scalar[] = [];
  for (const e of entries) {
    if (typeof e.value === 'number') out.push({ kind: 'number', value: e.value });
    else if (typeof e.value === 'string') out.push({ kind: 'string', value: e.value });
    else fail(`${name}: values must be numbers or strings`, { value: e.value });
  }
  if (out.some((s) => s.kind !== out[0]!.kind)) fail(`${name}: mixed numbers and strings`);
  return out;
}

function compareScalar(a: Scalar, b: Scalar): number {
  if (a.kind === 'number' && b.kind === 'number')
    return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  return compareUtf8(String(a.value), String(b.value));
}

function extreme(entries: readonly FrontierEntry[], name: string, sign: 1 | -1): JsonValue {
  const values = scalars(entries, name);
  let best = values[0]!;
  for (const v of values) if (compareScalar(v, best) * sign > 0) best = v;
  return best.value;
}

export const max: Resolver = (entries) => extreme(entries, 'max', 1);
export const min: Resolver = (entries) => extreme(entries, 'min', -1);

/**
 * Union of all array values, de-duplicated by canonical encoding and sorted by the UTF-8 bytes
 * of each element's canonical encoding (D7). Code-point order equals UTF-8 byte order.
 */
export const setUnion: Resolver = (entries) => {
  requireEntries(entries, 'set-union');
  const byEncoding = new Map<string, JsonValue>();
  for (const e of entries) {
    if (!Array.isArray(e.value))
      fail('set-union: every value must be an array', { value: e.value });
    for (const item of e.value) byEncoding.set(encodeCanonical(item), item);
  }
  return [...byEncoding.keys()].sort(compareUtf8).map((k) => byEncoding.get(k)!);
};

/** The frontier value with the highest index in the rank map (R6.5). */
export const maxRank: Resolver = (entries, context: ResolverContext) => {
  requireEntries(entries, 'max-rank');
  const rankMap = context.rankMap;
  if (rankMap === undefined || rankMap.length === 0)
    fail('max-rank: a non-empty rank map is required');
  let bestIndex = -1;
  for (const e of entries) {
    const index = rankMap.indexOf(e.value);
    if (index < 0) fail('max-rank: value is not in the rank map', { value: e.value });
    if (index > bestIndex) bestIndex = index;
  }
  return rankMap[bestIndex]!;
};

/** Resolvers selected by name. `custom` fields carry their own resolver (`f.custom`). */
const REGISTRY: Readonly<Record<Exclude<ResolverName, 'custom'>, Resolver>> = {
  'last-writer-wins': lastWriterWins,
  max,
  min,
  'set-union': setUnion,
  'max-rank': maxRank,
  counter,
};

export const RESOLVER_NAMES = Object.keys(REGISTRY) as Array<Exclude<ResolverName, 'custom'>>;

export function getResolver(name: ResolverName): Resolver {
  const r = (REGISTRY as Record<string, Resolver | undefined>)[name];
  if (r === undefined) fail(`Unknown resolver "${String(name)}"`);
  return r;
}

export function resolveField(
  name: ResolverName,
  entries: readonly FrontierEntry[],
  context: ResolverContext = {},
): JsonValue {
  return getResolver(name)(entries, context);
}
