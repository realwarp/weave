# ADR-0004: Conflict resolution as a function of the field frontier

Status: accepted. Shipped in 0.1.0; the counter and custom resolvers ([ADV]) were added in 0.2.0
(task T5.4, ADR-0015). Requirements: R6, R6.10, D5, design 5.2.

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
- Custom resolvers (`f.custom` with `defineResolver`) and the `counter` resolver are [ADV]. In
  0.1.0 they were not implemented; 0.2.0 implements both within this decision (pure functions of
  the frontier), and `assertResolverDeterministic` tests a custom resolver the same way. See
  ADR-0015 and the resolver guide.
