# ADR-0001: Architecture selection

Status: accepted. Requirement: R17.1, R17.4.

## Context

WEAVE must let devices work offline, exchange changes later, and converge to one state. It must be
reusable beyond two demo apps, correct under duplicate, dropped and reordered delivery, and small
enough to build and test completely. Clocks on devices cannot be trusted (A5).

## Options compared

| Approach | What it gives | Cost for WEAVE |
|---|---|---|
| State-based CRDTs (CvRDT) | Merge whole states; no op log needed | Every field type needs a hand-built lattice; whole-state transfer; hard to audit who changed what; deletes need tombstone design anyway |
| Operation-based CRDTs (CmRDT) | Small messages; strong convergence proofs per type | Needs reliable causal delivery from the transport; per-type design; we want arbitrary record fields |
| Event sourcing with an operation log | Immutable history, audit, rebuild, replay | By itself says nothing about conflicts; needs a merge rule and idempotent delivery |
| Last-writer-wins by wall-clock timestamp | Trivial | Wrong under clock skew (A5); silently loses concurrent edits |
| Central-server-authoritative sync | Simple conflict story (server decides) | Offline devices cannot reconcile without the server; the server must understand app semantics; single point of failure |
| Peer-to-peer replication | No server | Devices rarely online together; needs discovery and NAT traversal; hard for the demo |
| Relay (store-and-forward) topology | Devices never need to meet; relay can stay dumb | One more process; the relay is not a source of truth |

## Decision

WEAVE is an **operation-log replication library** with these concepts:

Adopted:
- An **immutable, hash-protected operation log**; state is derived from it (event-sourcing idea, ADR-0002).
- **Version vectors and causal contexts** per operation, with a Lamport counter for a total order.
- A **CRDT-style deterministic merge**: per-field *resolvers* that are pure functions of the field's
  frontier (the set of unsuperseded ops), so the result depends only on the op set (ADR-0004).
  We adopt the convergence idea, not a CRDT library and not per-type CRDT data structures.
- A **durable, semantically opaque relay** that stores and forwards ops (ADR-0007).
- The same sync protocol for replica-to-replica sync (in process in the MVP; over the network is [ADV]).

Not adopted:
- Central-server authority over conflict outcomes: the relay never resolves conflicts (R4.9, R4a.6).
- Timestamp-based last-writer-wins: ordering uses Lamport values and replica IDs only (A5).
- General CRDT libraries, per-type CRDT structures, and full event-sourcing frameworks.
- Peer-to-peer over a network in the MVP.

## Consequences

- State is a pure function of the accepted op set, so convergence, idempotency and rebuild are
  testable properties (R7, R15).
- Logs grow without bound until compaction ([ADV], off by default).
- Resolvers must be pure and order independent; the engine enforces this with property tests.
- The relay is replaceable; any replica can serve the same `SyncEndpoint` interface.
