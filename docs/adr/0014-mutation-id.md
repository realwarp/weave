# ADR-0014: Write idempotency keys (`mutationId`)

Status: accepted. Requirements: R5.4, design 7.2.

## Context

A write can commit and the app can then crash, lose the response, or retry after a timeout. A
blind retry would create a second op and, for example, a second record. Offline-first apps retry
often, so this must be safe by design.

## Options

1. No keys; accept duplicates.
2. Engine-generated IDs per call.
3. A required, caller-supplied `mutationId` per user intent.

## Decision

Option 3. Every `create`, `update` and `delete` takes a required `mutationId` (1 to 128 characters
of `[A-Za-z0-9_.:-]`). Omitting it is a TypeScript error and, at run time, `VALIDATION_FAILED` with
nothing written.

- The engine stores `mut/<mutationId>` with the result in the same transaction as the op.
- A repeat with the same ID and the same request returns the stored result with `replayed: true`
  and writes nothing.
- A repeat with the same ID and a different request fails with `MUTATION_ID_REUSED`.
- The caller creates one ID per user intent (`replica.newMutationId()`, or
  `newMutationId(random)` before the replica exists), **stores it with the pending action before
  the first attempt**, and reuses it on every retry. A fresh ID inside a retry loop defeats the
  mechanism and is forbidden by the project rules.

Option 2 was rejected: the engine cannot tell a retry from a new intent, so it cannot make retries
safe.

## Consequences

- Retries after a crash are exact replays (demo apps show `replayed: true`).
- Apps carry a small pending-actions store (both demo apps keep one in `localStorage`).
- `mut/` grows with every write; pruning is not part of the MVP.
