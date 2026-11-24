# ADR-0004: Conflict resolution as a function of the field frontier

Status: accepted. Requirements: R6, D5, design 5.2.

## Context

Two replicas can set the same field without seeing each other's write. Every replica must pick the
same value, whatever order the ops arrived in, and the losing values must stay visible.

## Options

1. Last writer wins on the whole record by timestamp.
2. Per-field CRDT types (registers, counters, sets) with their own merge state.
3. A pure resolver per field, applied to the field's **frontier**: the ops that set the field and
   that no other op setting it happens-after.

## Decision

Option 3. For each field, the engine computes the frontier from the op set (D5) and calls the
field's resolver with the frontier entries `{opId, lamport, replicaId, seq, value}`. A resolver is a
pure function of the entries as a multiset: no array position, clock, randomness or outside state.

Built-in resolvers: `last-writer-wins` (greatest D4 order), `max`, `min`, `set-union` (union,
de-duplicated by canonical encoding, sorted by UTF-8 bytes of the encoding) and `max-rank` (the
value latest in the field's declared rank list, for workflows such as `open < in_review < closed`).
`max-rank` replaced a separate status-machine type: the schema declares the order once.

A frontier with more than one entry is a conflict, even when the resolver picks one value.

## Consequences

- Determinism is testable: resolvers are called directly on random frontiers and all
  permutations (`packages/core/test/resolvers`).
- Wall clocks never affect results (only Lamport order does).
- Custom resolvers and a counter resolver are [ADV] and not implemented.
