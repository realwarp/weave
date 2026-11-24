# ADR-0013: State derived per record from the full op set; incremental frontier deferred

Status: accepted. Requirements: R7, D5, R20.5.

## Context

Derived state must be a pure function of the accepted op set (A5, D5). A late op can change a
field's frontier long after other ops were applied. The simplest correct method recomputes; faster
methods keep incremental state that can drift.

## Options

1. Incremental derivation: update each field's frontier as ops arrive.
2. Per-record recompute: when any op of a record is accepted, re-derive that record from all of its
   ops (found through the `rop/` index).

## Decision

Option 2. Applying a batch re-derives each touched record from its full op set and stores the
result in `rec/`. `rebuild()` re-derives every record and must leave all three hashes unchanged;
a property test checks it.

## Consequences

- Correct by construction: there is no incremental state that could disagree with the op set.
- Cost grows with a record's op count. The benchmark (T2.6) applies 10,000 ops over 500 records in
  about 1.3 s on a developer laptop, against a 5 s target.
- Incremental derivation stays possible later, checked against this method by the same properties.
