# ADR-0005: Conflict identity, current view, history log and at-most-once notifications

Status: accepted. Requirements: R6.11 to R6.14, R15.13, D8.

## Context

Applications must show users when their edit lost. A notification that is sent twice, or that is
lost by a crash, misleads users. Two replicas with the same ops must show the same conflicts.

## Options

1. Emit events as ops arrive, with no record.
2. Store a notification queue and deliver it at least once.
3. Derive conflicts from the op set, give each a deterministic ID, mark before emitting.

## Decision

Option 3.

- **Identity (D8).** A conflict's ID is the SHA-256 of the canonical encoding of its sorted
  frontier op IDs. Equal op sets give equal IDs on every replica.
- **Current view.** `conflicts.current()` lists open conflicts, read from the stored records.
- **History log.** `conflicts.history()` replays the record's ops in D4 order and lists every
  conflict that ever existed, `open` or `superseded`. It is a pure function of the op set, so it is
  equal across arrival orders and after `rebuild()`. Each record stores `conflictHistoryIds`.
- **Notifications.** After a commit, the engine writes `notified/<id>` for new IDs in one
  transaction and only then emits `conflict.new`. At startup it repairs: any history ID without a
  mark is marked and emitted. A crash before marking is repaired; a crash between marking and
  emitting loses that one event (at most once), and the conflict stays in the history.

## Consequences

- Apps build notice panels from `conflicts.history()`, so a missed event still shows (both demo
  apps do).
- A conflict superseded within one batch is still announced once, with status `superseded`.
- Crash windows are covered by `packages/core/test/engine/crash-windows.test.ts`.
