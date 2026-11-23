# Product: WEAVE

WEAVE is an open-source, reusable TypeScript foundation for offline-first applications. Devices
keep working with no connection, record every change as an immutable operation, exchange those
operations later, and end up with the same shared state.

Core idea: independent devices and records -> exchanged changes -> reconciled shared state.

## What ships

- `@weave/core`: operation log, canonical encoding, state derivation, conflict resolvers, schema
  migrations, sync engine.
- `@weave/storage`: memory, file (Node.js) and IndexedDB (browser) adapters.
- `@weave/transport`: in-process and HTTP client transports.
- `@weave/relay`: a small durable store-and-forward server.
- Two applications that use only WEAVE's public API: GHOSTLINE (community coordination) and
  FIELDNOTE (field operations).

## Source of truth

The approved specification is in `.kiro/specs/mission-build-weave-an-offline-first/`:
`requirements.md`, `design.md`, `tasks.md`. Do not implement anything that contradicts it. Mark a
task done only when its "Done when" line is true and its tests pass.

## Honesty rules

- Never present unimplemented functionality as complete. [ADV] features that are not built are
  listed as "not implemented".
- Never weaken a correctness guarantee (idempotency, determinism, convergence, integrity, crash
  recovery) to reduce scope.
