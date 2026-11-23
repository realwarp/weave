# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-24

First release: the MVP of the specification in `.kiro/specs/mission-build-weave-an-offline-first/`.

### Public API

`@weave/core`

- `createReplica({ storage, collections, logger?, clock?, random?, scheduler? })` returns a
  `Replica` with `id`, `collection(definition)`, `conflicts.current()` and `conflicts.history()`,
  `subscribe(listener)`, `sync(endpoint, options?)`, `endpoint()`, `status()`, `hashes()`,
  `rebuild()`, `newMutationId()` and `close()`.
- `Collection<T>`: `create(value, { mutationId })`, `update(id, patch, { mutationId })`,
  `delete(id, { mutationId })`, `get(id)`, `query({ where, orderBy, direction, includeDeleted })`
  and `history(id)` (operation history as `OpHistoryEntry[]`).
- `defineCollection({ name, version, fields, migrations })` and the field builders
  `f.string`, `f.number`, `f.boolean`, `f.json`, `f.set`, `f.rank`.
- Built-in resolvers: `last-writer-wins`, `max`, `min`, `set-union`, `max-rank`.
- `newMutationId(random)`, `platformRandom`, `randomFloat`, `systemClock`, `systemScheduler`.
- `WeaveError`, `isWeaveError`, `ERROR_CODES`, and the contract types (`SyncResult`,
  `ConflictRecord`, `Hashes`, `StorageAdapter`, `SyncEndpoint` and others).

`@weave/core/protocol`: wire types and opaque helpers for adapter and relay authors (op-line
verification, envelope reading, prefix selection, version vectors, identifiers).

`@weave/storage`: `memoryStorage` (`/memory`), `fileStorage` (`/file`, journal with checksums,
locking and documented manual recovery), `indexedDbStorage` (`/indexeddb`, tested in Chromium).

`@weave/transport`: `inProcessTransport` (`/in-process`), `httpTransport` (`/http`) and the
NDJSON helpers.

`@weave/relay`: `RelayCore`, `createRelayServer`, `listen`, `startRelay` and the `weave-relay` CLI
(bearer token, limits, redacted logs, request validation, graceful shutdown).

`@weave/testing` (development only, not published): storage and transport conformance suites,
`crashingStorage`, `FaultyEndpoint`, seeded randomness, fake clock and scheduler, the simulator and
fast-check generators.

### Applications

- GHOSTLINE (`apps/ghostline`): community coordination with announcements, claimable requests
  and a notices panel.
- FIELDNOTE (`apps/fieldnote`): field inspections with a v1 to v2 schema migration and a conflict
  history view.

Both have a browser UI, a scripted demo through a real relay process, and a Playwright smoke test.

### Guarantees and checks

Idempotent writes with a required `mutationId`; deterministic state as a function of the accepted
op set; all-or-nothing batch validation with per-origin isolation; a verified sync point
(`complete` only when `E == L_start == L_end`); crash recovery of the file journal; property,
scenario, fuzz, browser, relay end-to-end and benchmark suites.

### Not implemented ([ADV])

- Compaction and `removePeer`.
- Snapshot bootstrap.
- `restore` and the `update-wins` delete policy.
- The counter resolver and custom resolvers.
- Holding newer-schema ops (mixed-version writing).
- The authorization hook and authenticated identity.
- Peer bans.
- WebSocket transport and direct network sync.
- The GHOSTLINE "me too" counter.
