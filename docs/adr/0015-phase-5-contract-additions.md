# ADR-0015: Contract additions for the [ADV] features (0.2.0)

Status: accepted (grows with each Phase 5 task). Requirements: requirements section 3 (ADV), R3.6 to
R3.14, R4.8, R6.9, R6.10, R8.7, R10.5, R16.3, R16.4, R4.4.

## Context

The contracts in `packages/core/src/contracts/` were frozen at Gate 0 and shipped in 0.1.0. The
[ADV] features need new public API: compaction, snapshots, `restore`, new resolvers, held ops,
authorization, bans and a WebSocket transport. Code written against 0.1.0, including the two demo
apps and any third-party adapter or transport, must keep working unchanged.

## Options

1. Change existing types where the features touch them (for example widen `kind` or make new
   fields required).
2. Add only: new optional fields, new methods, new error codes and new types. Change no existing
   meaning.

## Decision

Option 2. Every Phase 5 contract change is an addition, recorded here, and marked `[ADV]` in its
doc comment. Rules:

- New fields on existing request, response and option types are **optional**; their absence
  means 0.1.0 behaviour. Old endpoints never send them; old clients ignore them.
- New methods go on `Replica` and `SyncHost` only (both implemented solely by `@weave/core`);
  new `SyncHost` methods are optional.
- New error codes are appended to `ERROR_CODES`; existing codes keep their meaning.
- Every [ADV] feature is off unless the developer turns it on.

### Additions so far

| Task | Addition |
| ---- | -------- |
| T5.1 | Error codes `PEER_REMOVED`, `UNAUTHORIZED`, `PEER_BANNED` (the last two are used by T5.6 and T5.7). |
| T5.1 | `PullResponse.compaction?: CompactionInfo` (`horizon`, `compactedThrough`, `removed`), published by the relay. |
| T5.1 | Storage keys `meta/compaction` (`MetaCompaction`) and `chist/<collection>/<recordId>` (conflict history kept after compaction). |
| T5.1 | `CreateReplicaOptions.compaction?: CompactionOptions` (`enabled`, `members`), `Replica.compact(): Promise<CompactionReport>`, `Replica.removePeer(id)`, `ReplicaStatus.compaction?`, optional `SyncHost.noteCompaction?(info)`. |
| T5.2 | `Snapshot` (format `weave-snapshot/1`: source, vectors, `compactedThrough`, removed list, every op line, kept conflict history, SHA-256 `hash`); optional `SyncEndpoint.snapshot?()` and `putSnapshot?(s)`; `Replica.exportSnapshot()` and `Replica.bootstrap(snapshotOrEndpoint): Promise<BootstrapReport>`. Relay: `RelayCore.snapshot()`, `RelayCore.putSnapshot()`, `GET` and `PUT /v1/snapshot`. |

### Snapshot design (T5.2)

- A snapshot holds **op lines, not derived state**: the importer verifies the hash and every op
  line, checks that the lines are exactly what the vectors promise (every `seq` above
  `compactedThrough` present, none above the vector), validates them against its own schema, and
  re-derives every record. A tampered or inconsistent snapshot changes nothing.
- Only an **empty** replica may bootstrap, and only with a replica ID the snapshot does not
  contain. A removed device therefore rejoins with new storage and a fresh ID (R3.10).
- After import the replica holds the source's op set (equal op-set hash), `compactedThrough` and
  removed list, and continues with normal sync. Conflicts that happened before it joined are
  marked as seen, so they are not announced as new.
- The relay stores one snapshot uploaded by a member, opaquely: it checks the hash and the op lines
  and requires the snapshot to cover everything the relay discarded. A smaller snapshot never
  replaces a larger one.
- Trust: the hash proves the snapshot was not altered after it was made, not that its maker was
  honest. State is always re-derived from verified op lines, but the kept conflict-history archive
  is taken as given. This is the compaction trust assumption of ADR-0006 (members follow the
  protocol); it is not safe against a malicious member.

## Consequences

- 0.1.0 apps, adapters and transports build and pass their tests against 0.2.0 unchanged; the
  0.1.0 regression suite runs on every Phase 5 commit.
- The version moves to 0.2.0 (new features, no breaking change).
- Implementers of `Replica` outside `@weave/core` would need the new methods; there are none, and
  the interface is documented as implemented by `createReplica` only.
