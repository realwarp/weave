# ADR-0006: Delete semantics, tombstone retention, and compaction safety (ADV)

Status: accepted (MVP part implemented; compaction is [ADV] and not implemented). Requirements: R3,
R6.7, R6.9, D6.

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
- `restore` and an `update-wins` policy are [ADV] (they need restore ops that name the deletes they
  cancel). They are not implemented: the MVP API has no `restore` method, and receiving replicas
  reject any op kind other than `set` and `delete`.

### Trust assumption for compaction

The relay cannot verify that a member really stored everything it acknowledged; it only records the
claim. Compaction therefore **assumes that registered members follow the acknowledgement protocol**:
they acknowledge only after durable storage and never claim more than they hold. It is **not**
Byzantine-safe. A member that over-claims, by mistake or on purpose, could cause ops to be
compacted that it does not have, and that member would then miss them.

## Consequences

- MVP storage grows with every op, including deletes. Acceptable at the target scale.
- The acknowledgement rules (ADR-0007) already record what compaction will need.
- The threat model (`docs/threat-model.md`) lists the over-claim limit.
