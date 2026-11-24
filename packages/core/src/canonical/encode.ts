/**
 * Canonical encoding (D7, design 4).
 *
 * - `encodeCanonical` writes RFC 8785 JSON: object member names sorted by UTF-16 code units,
 *   ECMAScript number form, no whitespace. It accepts any finite JSON tree.
 * - `assertSupported` enforces WEAVE's stricter value rules (safe integers, no lone surrogates,
 *   plain objects and arrays only, depth limit) and throws `UNSUPPORTED_VALUE`.
 * - `toCanonical` does both and is what the engine uses for every stored or hashed value.
 * - `compareUtf8` is the WEAVE-defined ordering (UTF-8 byte order); it is never used for
 *   member-name order inside canonical JSON.
 */
import { WeaveError } from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';

export const DEFAULT_MAX_DEPTH = 32;

export interface SupportLimits {
  /** Maximum nesting depth of arrays and objects (default 32). */
  readonly maxDepth?: number;
}

function unsupported(path: string, reason: string): never {
  throw new WeaveError('UNSUPPORTED_VALUE', `Unsupported value at ${path}: ${reason}`, {
    details: { path, reason },
  });
}

/** True when `s` contains an unpaired UTF-16 surrogate. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function pathKey(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Throws `UNSUPPORTED_VALUE` (with the JSON path) unless `value` is a D7-supported value:
 * `null`, booleans, strings without lone surrogates, finite numbers whose integer values lie in
 * the safe range, arrays, and plain objects with string keys. `-0` is allowed (it encodes as `0`).
 */
export function assertSupported(
  value: unknown,
  limits: SupportLimits = {},
): asserts value is JsonValue {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const ancestors = new Set<object>();

  const visit = (v: unknown, path: string, depth: number): void => {
    if (v === null || v === true || v === false) return;
    switch (typeof v) {
      case 'string':
        if (hasLoneSurrogate(v)) unsupported(path, 'string contains a lone surrogate');
        return;
      case 'number':
        if (!Number.isFinite(v)) unsupported(path, `non-finite number ${String(v)}`);
        if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
          unsupported(path, `integer ${String(v)} is outside the safe range`);
        }
        return;
      case 'undefined':
        return unsupported(path, 'undefined');
      case 'bigint':
        return unsupported(path, 'bigint');
      case 'symbol':
        return unsupported(path, 'symbol');
      case 'function':
        return unsupported(path, 'function');
      default:
        break;
    }
    const obj = v as object;
    if (depth >= maxDepth) unsupported(path, `nesting deeper than ${maxDepth}`);
    if (ancestors.has(obj)) unsupported(path, 'cyclic structure');
    if (Object.getOwnPropertySymbols(obj).length > 0) unsupported(path, 'symbol keys');
    ancestors.add(obj);
    if (Array.isArray(obj)) {
      if (Object.getPrototypeOf(obj) !== Array.prototype) unsupported(path, 'array subclass');
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) unsupported(`${path}[${i}]`, 'sparse array hole');
        visit((obj as unknown[])[i], `${path}[${i}]`, depth + 1);
      }
    } else {
      const proto: unknown = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        const name =
          (obj as { constructor?: { name?: unknown } }).constructor?.name ?? 'unknown class';
        unsupported(path, `instance of ${String(name)}`);
      }
      for (const key of Object.keys(obj)) {
        if (hasLoneSurrogate(key)) unsupported(path, 'object key contains a lone surrogate');
        visit((obj as Record<string, unknown>)[key], pathKey(path, key), depth + 1);
      }
    }
    ancestors.delete(obj);
  };

  visit(value, '$', 0);
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new WeaveError('UNSUPPORTED_VALUE', `Cannot encode non-finite number ${String(n)}`);
  }
  // String(-0) is "0", and String() is the ECMAScript number-to-string form RFC 8785 requires.
  return String(n);
}

/**
 * RFC 8785 canonical JSON. Member names are sorted with the default JavaScript string order,
 * which compares UTF-16 code units, exactly as RFC 8785 requires.
 */
export function encodeCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += encodeCanonical(value[i]);
    }
    return out + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    let out = '{';
    let first = true;
    for (const key of keys) {
      const member = obj[key];
      if (member === undefined) {
        throw new WeaveError('UNSUPPORTED_VALUE', `Cannot encode undefined member "${key}"`);
      }
      if (!first) out += ',';
      first = false;
      out += JSON.stringify(key) + ':' + encodeCanonical(member);
    }
    return out + '}';
  }
  throw new WeaveError('UNSUPPORTED_VALUE', `Cannot encode a value of type ${typeof value}`);
}

/** `assertSupported` followed by `encodeCanonical`. Use this for every stored or hashed value. */
export function toCanonical(value: unknown, limits: SupportLimits = {}): string {
  assertSupported(value, limits);
  return encodeCanonical(value);
}

/**
 * WEAVE-defined string ordering: by Unicode code point, which equals UTF-8 byte order.
 * Used for replica IDs (D4), state-hash entries, set-union output, string min/max and op-ID lists.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** UTF-8 bytes of a string. */
export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}
