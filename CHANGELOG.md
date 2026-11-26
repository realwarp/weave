# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] (proposed 0.2.0)

The [ADV] features of the specification (Phase 5, tasks T5.1 to T5.9), each implemented, tested
and independently reviewed (`docs/reviews/T5.*.md`). All additions are optional and off by
default; 0.1.0 code, adapters and transports work unchanged. Details and limits: ADR-0015.

### Added

- Compaction and `removePeer` (T5.1): `createReplica({ compaction })`, `replica.compact()`,
  `replica.removePeer()`, relay compaction and `/v1/admin/compact`, `/v1/admin/remove-peer`;
  `NEEDS_SNAPSHOT` and `PEER_REMOVED` errors. Deleted records keep a compact tombstone.
- Snapshot bootstrap (T5.2): `replica.exportSnapshot()`, `replica.bootstrap(snapshotOrEndpoint)`,
  relay `GET`/`PUT /v1/snapshot`; snapshots carry op lines and are fully re-verified on import.
- `restore` and the `update-wins` delete policy (T5.3): `defineCollection({ deletes })`,
  `collection.restore(id, { mutationId })`.
- Counter and custom resolvers (T5.4): `f.counter()`, `f.custom(base, defineResolver(name, fn))`,
  and the exported `assertResolverDeterministic` test helper.
- Holding newer-schema ops (T5.5): `createReplica({ holdNewerSchema: true })` and
  `status().held`; held ops are validated on upgrade.
- Authorization hook and authenticated identity (T5.6): `createReplica({ authorize })`,
  `replica.endpoint({ auth })`, relay `authorize` and `identities`; `UNAUTHORIZED` (HTTP 403).
- Peer ban (T5.7): `createReplica({ ban })`, `status().bans`; `PEER_BANNED`; monotonic time only.
- WebSocket transport and direct network sync (T5.8): `@weave/transport/websocket`
  (`websocketTransport`, browser and Node) and `@weave/transport/websocket/server`
  (`serveWebSocket`, Node), with no runtime dependency.
- GHOSTLINE "me too" counter (T5.9): requests move to schema version 2 with an unchanged
  migration; a 0.1.0 device is told to update (`PEER_SCHEMA_OLDER`).

### Changed

- Union types gained values: `OpPayload.kind` (`'restore'`), `ResolverName` (`'counter'`,
  `'custom'`) and `FieldKind` (`'counter'`). Code with an exhaustive `switch` over them must add
  cases. `verifyOpLine` now accepts `restore` ops structurally; a collection without restore still
  rejects them with `NOT_SUPPORTED`.

### Upgrading from 0.1.0

- A 0.1.0 store opens in place; no data migration is needed, and stored `mutationId`s still
  replay.
- Upgrade every device and the relay before turning on any Phase 5 feature. A 0.1.0 peer rejects
  `restore` ops (`NOT_SUPPORTED`), and it cannot define counter or custom fields or a `deletes`
  policy; it would apply an `update-wins` collection's ordinary ops with delete-wins rules.
- **Do not downgrade a store to 0.1.0 after any Phase 5 feature has written to it.** 0.1.0 does
  not detect the newer data: it opens the store without an error but can silently derive a
  different state. For example, with a stored `restore` op, 0.1.0 first shows the restored record
  from the saved index, and after `rebuild()` it ignores the restore and the record reads as
  deleted. Downgrading is not supported; keep a copy of the 0.1.0 data before turning on Phase 5
  features if you may need to go back.

### Fixed (after the 0.1.0 tag, PR #1 review)

- Apps: conflict views use the conflict frontier. The FIELDNOTE conflict history lists the
  frontier's migrated values, so a v1 `location` edit competing with a v2 `site` edit shows both;
  GHOSTLINE claim and delete notices count only this device's ops in the frontier, so an earlier,
  superseded claim no longer reports "claim lost". The boundary check lets apps read the public
  `ConflictRecord.frontier` field.

### Fixed (found by independent review during Phase 5)

- Held ops are now validated against the new schema when the app is upgraded (T5.5).
- The peer-ban window boundary is defined and tested (T5.7).
- The WebSocket frame parser does linear work for any chunking; a one-byte drip no longer costs
  quadratic CPU (T5.8).

### Fixed (PR #2 review, before release)

- Counter totals are summed exactly; a total near `Number.MAX_SAFE_INTEGER` (for example
  `MAX + 2 - 2`) no longer rounds, and only a true total outside the safe range is refused.
- The sync client checks a peer ban before storing the compaction horizon and removed list from a
  pull response, so a banned endpoint cannot influence `compact()`.
- A relay pull denied by the authorization hook after its selection changed no longer leaves the
  caller registered with an empty acknowledgement (which held the compaction horizon at zero).
- Relay `removePeer` runs through the push queue and raises the commit counter, so a push that
  was already running can no longer store an op after the removal took effect.
- Snapshot verification adds each op's `seq` to a per-origin set in place instead of copying the
  list for every op (linear instead of quadratic in one origin's history).
- Snapshot bootstrap refuses an op of a collection the app does not define with `SCHEMA_TOO_NEW`,
  as normal sync does; only a replica with `holdNewerSchema: true` stores it as held.
- Compaction keeps `mut/` records when it discards their ops, so a retry of a compacted mutation
  still returns the original result (`replayed: true`) or fails with `MUTATION_ID_REUSED`, as
  R5.4 promises. Trade-off: `mut/` keeps one small entry per local write for the life of the
  replica; there is no expiry.

### Fixed (merged from `main`, PR #3)

- File adapter: a takeover race could leave no lock owner. Step 6 of the guarded open now writes
  `LOCK.new-*` and renames it over `LOCK`, so `LOCK` never goes missing (design 9.1).
- File adapter: a takeover whose replacement fails no longer throws a raw filesystem error. It
  returns typed errors with `details.reason`, `details.cause` and `details.retryDisposition`:
  Windows `EPERM`/`EACCES`/`EBUSY` give `STORAGE_LOCKED` (`rename-blocked`, `may-retry`); POSIX
  `EPERM`/`EACCES` give `STORAGE_ERROR` (`rename-not-permitted`, `operator-action-required`); any
  other error, or a back-out that cannot be proven, keeps `LOCK.recovery` and needs the manual
  recovery procedure (`rename-failed` or `cleanup-incomplete`, `manual-recovery-required`). The
  top-level `WeaveError.retryable` is unchanged (transport errors only).
- Requirements R9.6(d), R9.6(f), R10.1, R15.17 and R15.20 amended accordingly (at most one lock
  owner always; exactly one when a takeover succeeds). The recovery guide covers `LOCK.new-*` and
  tells the operator to read the guard's `observedLockNonce`.

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
