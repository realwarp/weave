# ADR-0008: Schema upgrade on read, contiguous-prefix delivery, all-or-nothing batch validation

Status: accepted. Requirements: R4.7, R4.10, R8, R15.11, R15.12.

## Context

Devices upgrade at different times, so a replica can meet ops written under a schema it does not
know yet. A batch can also contain one bad op among many good ones. Neither case may leave a replica
half-updated or with a gap in an origin's sequence.

## Options for schema evolution

1. Rewrite stored ops when the schema changes.
2. Upgrade ops when they are read, through pure migrations; deliver only what the receiver can read.
3. Let replicas store ops they cannot read and interpret them later (mixed-version holding).

## Options for validation

1. Accept the valid ops of a batch and drop the invalid ones.
2. Reject the whole batch on any invalid op, then retry per origin.

## Decision

- **Upgrade on read (schema option 2).** Stored ops are never rewritten. Each collection declares
  `migrations[n]` from version `n` to `n + 1`; a migration is a pure, total function of the op's own
  fields. State is derived from migrated fields, so upgraded replicas with the same ops have equal
  state hashes. Operation history shows ops as written.
- **Contiguous-prefix delivery.** A sender delivers each origin's ops in seq order and stops at the
  first op the receiver cannot read, reporting it as `blocked`. The receiver never holds a gap. The
  sync returns `partial` with code `PEER_SCHEMA_OLDER` and the blocked origins; after the receiver
  upgrades, the next sync delivers the rest.
- **All-or-nothing validation (validation option 2).** A batch is validated completely (structure,
  value rules, canonical form, hash, identity, schema) before anything is written. One failure
  rejects the whole batch; storage stays byte-identical. The sync engine then retries **per
  origin**, so good origins still arrive and the bad one is reported in `rejectedOrigins`.
- Mixed-version holding (schema option 3) is [ADV] and not implemented.

## Consequences

- No partial writes, ever: the fuzz suite checks that data files are unchanged after each rejected
  input.
- A replica that never upgrades keeps working on what it can read.
- Migrations must stay pure; tests check repeatability and chain equality.
