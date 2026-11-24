# ADR-0006: Delete semantics, tombstone retention, and compaction safety (ADV)

Status: accepted. MVP part shipped in 0.1.0; compaction ([ADV]) implemented in 0.2.0 (task T5.1,
"Compaction as built" below). Requirements: R3, R3.6 to R3.14, R6.7, R6.9, D6.

## Context

A delete must win reliably over concurrent edits, and a replica that was offline for a month must
not resurrect a deleted record. Keeping every op forever costs space, but removing ops too early
breaks convergence for members that have not received them.

## Options

1. Delete removes the record's ops at once.
2. Delete writes a tombstone op that is kept forever.
3. Tombstones kept until every member has acknowledged them, then compacted.

## Decision

- **MVP: option 2.** A delete is a `delete` op. A record is deleted if and only if at least one
  delete op for it exists (D6). A concurrent `set` does not keep it alive: delete wins. Deleted
  records keep their full operation history. Nothing is ever removed.
- **[ADV]: option 3, designed now so the MVP does not block it.** The relay publishes a horizon:
  for each origin, the lowest seq acknowledged by every registered member. Offline members count as
  zero. `removePeer` is explicit only; there is no time-based expiry. Ops at or below the horizon
  may be compacted.
- `restore` and an `update-wins` policy are [ADV]. In 0.1.0 they were not implemented: the API had
  no `restore` method, and receiving replicas rejected any op kind other than `set` and `delete`.
  0.2.0 (T5.3) implements both as per-collection opt-ins; see "Restore and update-wins" below and
  ADR-0015.

### Trust assumption for compaction

The relay cannot verify that a member really stored everything it acknowledged; it only records the
claim. Compaction therefore **assumes that registered members follow the acknowledgement protocol**:
they acknowledge only after durable storage and never claim more than they hold. It is **not**
Byzantine-safe. A member that over-claims, by mistake or on purpose, could cause ops to be
compacted that it does not have, and that member would then miss them.

### Compaction as built (0.2.0, T5.1)

- **Off by default.** `createReplica({ compaction: { enabled: true } })` and
  `new RelayCore({ compaction: { enabled: true } })` turn it on; `compact()` otherwise throws
  `NOT_SUPPORTED`.
- **Horizon.** The relay publishes `compaction: { horizon, compactedThrough, removed }` with every
  pull response. `horizon[o]` is the minimum, over every registered and not removed member, of
  that member's acknowledged `seq` for origin `o`, capped by the relay's own vector. A member
  becomes a member by its first request, before it receives data. A member that never
  acknowledged, or is offline, counts as zero, so nothing it may lack is discarded (R3.7). A
  replica uses the latest published horizon, capped by its own vector. Without a relay, a closed
  replica set (`compaction.members`) uses the minimum of this replica's vector and every other
  member's acknowledged vector.
- **What a replica discards.** For each record, the ops covered by the horizon that are in no
  field frontier, and only if the record derived from the remaining ops is identical (values,
  frontiers, deletion, open conflicts) to the stored record; otherwise the record keeps every op.
  Superseded `mut/` entries go with their ops. The record's conflict history is copied to
  `chist/<collection>/<recordId>` first, so `conflicts.history()` and notification marks are
  unchanged.
- **Tombstones (R3.13).** A deleted record keeps every op until a delete op is covered by the
  horizon (full tombstone). Then its covered `set` ops go and its delete ops stay: the compact
  tombstone (record ID plus delete op ID). A record with an open delete conflict keeps its ops.
  In a collection with `deletes.restore` or the `update-wins` policy a deleted record keeps every
  op (no compact tombstone), because it can become live again (T5.3).

### Restore and update-wins (0.2.0, T5.3)

- **Opt-in per collection.** `defineCollection({ ..., deletes: { policy, restore } })`. Without
  `deletes` the collection behaves exactly as in 0.1.0: delete wins and `restore()` and incoming
  restore ops fail with `NOT_SUPPORTED`. Every replica of a collection must use the same options,
  set when the collection is first defined; changing them on existing data changes what the same op
  set means.
- **Restore.** `collection.restore(recordId, { mutationId })` writes a `restore` op with empty
  fields. It cancels every delete op that happens-before it. A delete concurrent with the restore
  is not cancelled, so the record stays deleted until a later restore sees it. The record comes
  back with the values derived from all its `set` ops. Restoring a record that is not deleted is
  `VALIDATION_FAILED`.
- **Update-wins.** A delete is ignored when some `set` op on the record is concurrent with it. A
  delete that saw every `set` still deletes. The concurrency is still reported as a delete
  conflict.
- **Existence.** A record is deleted if and only if at least one delete is neither cancelled nor
  ignored. Local writes check this derived state (R6.8): a record that is live again accepts
  updates. A delete cancelled by a restore leaves the current conflict view and stays in the
  conflict history as `superseded`.
- **Compaction.** See the tombstone rule above: deleted records of these collections keep all ops.
  A live record still compacts covered, non-frontier ops, including cancelled deletes and their
  restores, under the usual "identical re-derived record" check.
- **What the relay discards.** Op lines covered by the horizon (every member holds them). The
  relay stays opaque: it reads no field values.
- **Never partial history (R3.9).** A request for ops of origin `o` after a `seq` below
  `compactedThrough[o]` fails with `NEEDS_SNAPSHOT` (HTTP 409 from the relay); the peer then
  bootstraps from a snapshot (T5.2).
- **`removePeer` (R3.10).** `RelayCore.removePeer(id)` (or `replica.removePeer(id)` in a closed
  set) records `removed[id] = last seq held`, durably. The member leaves the horizon; later ops
  from it fail with `PEER_REMOVED`; its earlier ops stay valid. The relay's list reaches replicas
  through the pull response. There is no time-based removal. A removed device rejoins only with a
  fresh replica ID through a snapshot.
- **Hashes.** `hashes().state` and `.conflicts` do not change when a replica compacts.
  `hashes().ops` covers the ops a replica holds, so replicas compare equal op-set hashes after
  compacting to the same horizon.

## Consequences

- MVP storage grows with every op, including deletes. Acceptable at the target scale. With
  compaction enabled, superseded history is reclaimed once every member holds it.
- The acknowledgement rules (ADR-0007) already record what compaction will need.
- The threat model (`docs/threat-model.md`) lists the over-claim limit.
