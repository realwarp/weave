# ADR-0003: Canonical encoding and hashing

Status: accepted. Requirements: D7, R15.10, R16.2.

## Context

Op hashes, state hashes and duplicate detection need one deterministic byte encoding that is
identical in Node.js and in browsers.

## Decision

- Encoding is RFC 8785 (JSON Canonicalization Scheme), strictly: object property names sorted by
  **UTF-16 code units**, ECMAScript number form, no whitespace, UTF-8 output.
- Only `null`, booleans, strings without lone surrogates, finite numbers (integers within the safe
  range), arrays and plain objects are accepted. `-0` is written as `0`. Everything else is
  rejected with `UNSUPPORTED_VALUE`.
- WEAVE-defined orderings (replica IDs, state-hash entries, set-union elements, string min/max,
  sorted op-ID lists) use **UTF-8 byte order**. The two orders are never mixed.
- Hashes are SHA-256 from `globalThis.crypto.subtle` (no dependency).
- The op hash covers `{replicaId, seq, lamport, context, collection, recordId, kind, schemaVersion, fields}`
  and excludes `hash` and `wallTime`.
- Test vectors (`packages/core/test/canonical/vectors.json`) include property names U+E000 and
  U+10000, which sort differently in UTF-16 and UTF-8. They are checked by an independent
  plain-JavaScript implementation and run in Node and in Chromium.

## Consequences

- Applications convert dates, binary data and so on to supported values before writing.
- Two replicas always produce identical bytes and hashes for the same value.
