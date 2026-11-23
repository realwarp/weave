# WEAVE architecture

WEAVE is an operation-log replication library. This page is the short version of
`.kiro/specs/mission-build-weave-an-offline-first/design.md`.

## Idea

independent devices and records -> exchanged changes -> reconciled shared state.

1. Every write becomes one immutable, hash-protected **op** (`replicaId`, `seq`, `lamport`, `context`, fields).
2. A replica's state is **derived** from the accepted ops by a pure function. Arrival order never matters.
3. Replicas exchange ops using **version vectors**. A durable **relay** stores and forwards ops.
4. Concurrent edits to one field are merged by a **pure resolver** that sees the whole field frontier.
5. Storage and transport are **adapters** behind small interfaces.

## Components

See `docs/diagrams/components.md`. Packages:

| Package | Job |
|---|---|
| `@weave/core` | ops, canonical encoding, schema and migrations, resolvers, state derivation, engine, sync engine |
| `@weave/storage` | memory, file (Node.js, journal with checksums) and IndexedDB adapters |
| `@weave/transport` | in-process and HTTP client transports |
| `@weave/relay` | durable store-and-forward server and CLI |
| `@weave/testing` | conformance suites, simulator, fault injection (dev only) |

## Key guarantees

- **Idempotency:** applying a batch twice equals applying it once. Every write carries a caller-supplied `mutationId`.
- **Determinism:** state is a function of the accepted op set only. Clocks are display data.
- **Convergence:** replicas that hold the same op set hold the same state, hashes and conflict view.
- **Integrity:** every op is verified (structure, canonical form, hash). Bad batches are rejected whole.
- **Crash safety:** every state change is one atomic storage transaction.

Decisions are in `docs/adr/`.
