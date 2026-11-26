# WEAVE documentation

New here? Read the [root README](../README.md) first, then [getting started](guides/getting-started.md).

## Use WEAVE

| Page                                              | What it covers                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Getting started](guides/getting-started.md)      | Install, build, run both apps and their headless demos, run every test, development workflow, troubleshooting |
| [Core API](guides/core-api.md)                    | Replicas, collections, fields, writes and `mutationId`, queries, sync, status, conflicts, snapshots   |
| [Resolvers](guides/custom-resolver.md)            | Built-in merge rules, counter fields, custom resolvers and how to test them                         |
| [Migrations](guides/migrations.md)                | Schema versions, migrations, mixed-version sync, holding newer-schema ops                           |
| [Custom storage](guides/custom-storage.md)        | Writing a storage adapter and running the conformance suite                                         |
| [Custom transport](guides/custom-transport.md)    | Writing a transport and running the conformance suite                                               |
| [Storage recovery](guides/storage-recovery.md)    | Stale locks (`STORAGE_LOCKED`) and damaged files (`STORAGE_CORRUPT`)                                |

Package references: [`@weave/core`](../packages/core/README.md),
[`@weave/storage`](../packages/storage/README.md),
[`@weave/transport`](../packages/transport/README.md),
[`@weave/relay`](../packages/relay/README.md), [`@weave/testing`](../packages/testing/README.md).
The generated API reference is built with `npm run docs:api` into `docs/api/` (not checked in).

## Understand WEAVE

| Page                                              | What it covers                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architecture](architecture.md)                   | The idea, the packages and the guarantees, in one page                 |
| [Component diagram](diagrams/components.md)       | How the parts of a device and the relay connect                        |
| [Sync sequence](diagrams/sync-sequence.md)        | One sync, step by step                                                  |
| [Protocol](protocol.md)                           | The `SyncEndpoint` calls and their wire format                          |
| [Threat model](threat-model.md)                   | What is defended, what is not, and the dependency audit                 |
| [App differences](app-differences.md)             | How the GHOSTLINE and FIELDNOTE data models differ (generated)          |

## Decision records

Every significant design choice has an architecture decision record in [`adr/`](adr/), numbered
in the order they were made. Each one states the context, the options, the decision and its
consequences.

| ADR                                                     | Topic                                              |
| ------------------------------------------------------- | -------------------------------------------------- |
| [0001](adr/0001-architecture-selection.md)              | Architecture selection (operation log)             |
| [0002](adr/0002-operation-identity-and-ordering.md)     | Operation identity and ordering                    |
| [0003](adr/0003-canonical-encoding-and-hashing.md)      | Canonical encoding and hashing                     |
| [0004](adr/0004-conflict-resolution.md)                 | Conflict resolution                                |
| [0005](adr/0005-conflict-identity-and-notifications.md) | Conflict identity and notifications                |
| [0006](adr/0006-deletes-and-compaction.md)              | Deletes, tombstones and compaction                 |
| [0007](adr/0007-relay-design.md)                        | Relay design                                       |
| [0008](adr/0008-schema-upgrade-and-validation.md)       | Schema upgrade and batch validation                |
| [0009](adr/0009-storage-and-journal.md)                 | Storage and the file journal                       |
| [0010](adr/0010-transport-and-sync.md)                  | Transports, retry and the verified sync point      |
| [0011](adr/0011-dependencies.md)                        | Dependencies                                       |
| [0012](adr/0012-monorepo-layout.md)                     | Monorepo layout                                    |
| [0013](adr/0013-per-record-derivation.md)               | Per-record state derivation                        |
| [0014](adr/0014-mutation-id.md)                         | The required `mutationId`                          |
| [0015](adr/0015-phase-5-contract-additions.md)          | The 0.2.0 additions and their limits               |

The full specification is in
[`.kiro/specs/mission-build-weave-an-offline-first/`](../.kiro/specs/mission-build-weave-an-offline-first/)
(`requirements.md`, `design.md`, `tasks.md`).

## Project history and process

| Page                                  | What it covers                                                          |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [CHANGELOG](../CHANGELOG.md)          | Every change by version, with upgrade notes                              |
| [Phase 5 report](phase-5-report.md)   | How the 0.2.0 features were built, reviewed and fixed                   |
| [Demo plan](demo-plan.md)             | A three-minute demonstration script                                     |
| [Built with Kiro Crew](kiro-crew.md)  | How the project was built                                               |
| [Disclosure](disclosure.md)           | Prior code, third-party code, AI assistance, license                    |
| [Review reports](reviews/)            | The independent review of every task and gate                           |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).
