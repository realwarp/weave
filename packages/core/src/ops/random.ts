/**
 * Randomness (design 7.1, R5.4, R10.2). `Random.randomBytes` is the only primitive; numbers and
 * identifiers are derived from it deterministically, so a seeded `Random` gives reproducible
 * results. Nothing here uses `Math.random`.
 */
import type { Random } from '../contracts/env.js';

const MAX_CHUNK = 65_536;

/** Randomness from `globalThis.crypto.getRandomValues` (Node.js 22 and browsers). */
export const platformRandom: Random = {
  randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += MAX_CHUNK) {
      globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + MAX_CHUNK)));
    }
    return out;
  },
};

function take(random: Random, length: number): Uint8Array {
  const bytes = random.randomBytes(length);
  if (bytes.length < length) {
    throw new RangeError(`Random.randomBytes(${length}) returned ${bytes.length} bytes`);
  }
  return bytes;
}

/**
 * A uniform number in [0, 1) from 8 random bytes read as an unsigned BIG-ENDIAN 64-bit integer,
 * keeping its 53 most significant bits: `(hi * 2^21 + (lo >>> 11)) / 2^53`.
 */
export function randomFloat(random: Random): number {
  const b = take(random, 8);
  const hi = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const lo = ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0;
  return (hi * 2 ** 21 + (lo >>> 11)) / 2 ** 53;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 (lowercase, no padding) of `bytes`. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]!;
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Pattern of replica IDs and mutation IDs made by WEAVE: 26 base32 characters. */
export const REPLICA_ID_PATTERN = /^[a-z2-7]{26}$/;

/** A new replica ID: 128 random bits as 26 lowercase base32 characters. */
export function newReplicaId(random: Random): string {
  return base32(take(random, 16));
}

/** A new record ID: 128 random bits as 32 lowercase hex characters. */
export function newRecordId(random: Random): string {
  return hex(take(random, 16));
}

/**
 * A new mutation ID: 128 random bits as 26 lowercase base32 characters. Call it ONCE per user
 * intent and store the result with the intent before calling a write; never in a retry loop.
 * There is intentionally no default `Random`.
 */
export function newMutationId(random: Random): string {
  return base32(take(random, 16));
}
