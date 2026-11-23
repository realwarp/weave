# ADR-0002: Operation identity, causal metadata and ordering

Status: accepted. Requirements: D1 to D4, R2.

## Context

Replicas write independently. We need identities that never collide, an order every replica agrees
on, and a way to know which edits saw which other edits, without trusting wall clocks.

## Decision

- An op is identified by `(replicaId, seq)`. `seq` is global per replica (not per collection),
  starts at 1 and has no gaps (D1). A replica accepts remote ops from an origin only as a
  contiguous prefix.
- Each op carries a Lamport value `lamport = 1 + max(lamport over accepted ops)` and the writer's
  **full accepted version vector** as `context` (D2). The full vector is stored, sent and hashed.
  A compact storage form is an optional later optimization that must rebuild the full vector first.
- `A happens-before B` iff `B.context[A.replicaId] >= A.seq`. No transitivity or causal delivery
  is assumed anywhere (D3).
- The total order is `(lamport, replicaId by UTF-8 bytes, seq)` (D4).
- Ops waiting for a sequence gap sit in a pending buffer. They are **not accepted**: they do not
  count for `lamport`, `context`, hashes, acknowledgements or the version vector.

## Alternatives rejected

- Hybrid logical clocks: they read wall-clock time, which A5 forbids for ordering.
- Per-collection sequence numbers: more state; the contiguous-prefix delivery rule (ADR-0008) works with one global sequence.
- Compact contexts in the MVP: two representations to keep consistent for no demonstrated need.

## Consequences

- Contexts grow with the number of replicas (acceptable for tens of replicas).
- Any replica can verify causality from the op alone.
