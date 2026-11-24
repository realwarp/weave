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

| T5.3 | `CollectionDefinition.deletes?: DeleteOptions` (`policy?: 'delete-wins' \| 'update-wins'`, `restore?: boolean`); `Collection.restore(recordId, { mutationId })`; `'restore'` in `OpPayload.kind`, `OpHistoryEntry.kind` and `ChangeEvent.kind`. |

| T5.4 | `ResolverName` gains `'counter'` and `'custom'`; `FieldKind` gains `'counter'`; `FieldSpec.custom?: CustomResolver`; `CustomResolver` type; `f.counter()`, `f.custom(base, resolver)`; exported `defineResolver(name, fn)` and `assertResolverDeterministic(resolver, samples, options?)` with `AssertResolverOptions`. |

| T5.5 | `CreateReplicaOptions.holdNewerSchema?: boolean`; `ReplicaStatus.held?: HeldStatus` (`ops`, `needs`); `PullRequest.hold?: boolean`; optional `SyncHost.holdsNewer?()`; storage keys `held/<origin>/<seq>`. Relay: `hold` accepted on `/v1/pull`. |

### Held newer-schema ops (T5.5)

- **Off by default.** Without `holdNewerSchema` the prefix rule of R4.10 is unchanged.
- **What is held.** An op whose collection this code does not define, or whose `schemaVersion` is
  newer. With the option, such ops are **accepted**: stored in `op/` and `rop/`, counted in the
  vector, the op-set hash and acknowledgements, buffered and promoted like any op, and served to
  peers (store and forward). This keeps D1 contiguity (R8.7). A `held/<origin>/<seq>` marker
  records each one for `status()`.
- **Excluded from state.** Records are derived from readable ops only; a record with no readable
  op has no derived record. Held ops emit no change events. `status().held` reports the held op
  count and, per collection, the schema version needed.
- **Peers send everything.** A holding replica's endpoint reports `support: '*'`, and its pulls
  carry `hold: true`, which the relay and replica endpoints honour. Old endpoints ignore the flag
  and apply the prefix rule (the sync is then `partial`, as in 0.1.0).
- **Upgrade.** On open, every held op the new code can read is first validated with the phase A2
  rules (field types after migration; restore only where enabled). Then, in one transaction,
  records of upgraded and newly defined collections are re-derived, markers of valid ops are
  removed, and an op that fails validation keeps its marker with `invalid: true`. Invalid ops
  stay stored but never enter state (across rebuilds and restarts), writes to their records fail
  with `VALIDATION_FAILED`, and `status().held.invalid` counts them: their writer was faulty, and
  a replica that received them directly would have rejected them. With valid held ops only, the
  upgraded replica has the same state and op-set hashes as one that never held anything.
- **Local writes.** A write to a record that has held ops fails with `SCHEMA_TOO_NEW`: it would
  causally follow changes this code cannot see and could supersede them unseen (for example lose
  a counter's held deltas). Mixed-version writing stays out of scope (R8.7).
- **Compaction and snapshots.** Records with held ops keep every op. Snapshot bootstrap with the
  option holds newer ops instead of failing with `SCHEMA_TOO_NEW`.

### Counter and custom resolvers (T5.4)

- **Counter.** A counter field's op value is a counter state `{ [replicaId]: [p, n] }`: the totals
  of that replica's positive and negative deltas, safe integers that only grow. Writes take a delta
  (`update(id, { likes: 1 })`); the engine merges every state the replica holds for the field (the
  larger total per replica) and adds the delta to its own totals, inside the same write attempt.
  So every op's state covers all ops it causally follows, and the frontier carries the full
  count. The resolver merges the frontier states and returns the sum of `p - n`. Merging is
  commutative, associative and idempotent; totals are exact integers. Reads give the number.
  Compaction keeps frontier ops, so the count survives it. Incoming ops must carry a well-formed
  state (phase A2, `VALIDATION_FAILED`). A faulty writer that sends a smaller state in a later op
  can lower the count, the same trust level as any field write.
- **Custom.** `f.custom(base, defineResolver(name, fn))` gives one field its own resolver. There is
  no global registry: replicas agree exactly when their collection definitions use the same code,
  as with migrations. Every result is checked: a resolver that throws, returns a non-D7 value or a
  value that fails the base field's type check gives `RESOLVER_ERROR` (the batch or the write is
  rejected; nothing is stored).
- **`assertResolverDeterministic`.** Calls the resolver directly with every order of each sample
  (up to 6 entries) or a fixed set of seeded orders (default 200), on frozen copies, and requires
  the same canonical result each time. It catches position dependence, hidden state, input
  mutation and failures. It is a test helper: passing it is evidence, not proof, of purity.
- **Widened unions.** `ResolverName` and `FieldKind` gain values. Code with an exhaustive `switch`
  over them must add cases when it upgrades; the values only appear on fields built with the new
  builders.

### Restore and update-wins (T5.3)

- Semantics are in ADR-0006 ("Restore and update-wins") and D6. Both are pure functions of the op
  set and the collection's `deletes` options (`packages/core/src/state/restore.ts`).
- **The one widened union.** `kind` gains the value `'restore'`. This is the only Phase 5 change
  that widens an existing type, and the design (section 15 table) reserved it. The
  value can only appear for collections that set `deletes.restore`, so 0.1.0 code that never opts
  in never sees it at run time. TypeScript code with an exhaustive `switch` over `kind` must add a
  case when it upgrades; both demo apps compile unchanged.
- **Mixed versions.** `verifyOpLine` now accepts `restore` structurally (empty fields required). A
  replica rejects a restore op with `NOT_SUPPORTED` (the whole batch, as in 0.1.0) unless the op's
  collection enables restore. A 0.1.0 relay or replica rejects restore ops with `NOT_SUPPORTED`,
  so a group that enables restore must upgrade every member and the relay first.

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
