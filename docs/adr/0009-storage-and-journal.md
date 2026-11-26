# ADR-0009: Storage interface, key layout, file journal with generations, IndexedDB mapping

Status: accepted. Requirements: R9, R10.4, R15.17, design 9.

## Context

WEAVE runs in browsers and in Node.js. The engine needs atomic, durable transactions over ordered
keys. A process can be killed at any byte; after a restart the data must be a whole-transaction
prefix, and two processes must never write one directory.

## Options

1. SQLite in Node.js and IndexedDB in browsers.
2. A small ordered key-value interface with three adapters: memory, a file journal, IndexedDB.

## Decision

Option 2 (SQLite was rejected: a native or WASM runtime dependency).

- **Interface.** `open`, `close`, `transaction(mode, fn)`; `tx.get/put/delete/scan(prefix, {after,
  limit})`. A `rw` transaction is atomic and durable when it resolves. `fn` awaits only `tx` calls
  (IndexedDB closes idle transactions; a lint rule enforces this in the IndexedDB adapter).
- **Key layout.** `meta/replica`, `meta/state`, `meta/schema`, `op/<origin>/<seq>`, `pend/…`,
  `rop/…` (per-record index), `rec/…` (derived state), `mut/<mutationId>`, `peer/<id>`,
  `notified/<conflictId>`. Seqs are zero-padded to 12 digits so string order is numeric order.
- **File journal.** Each committed transaction is one appended record: a 32-byte header (magic,
  generation, epoch, transaction ID, payload length, and a `headerCheck` over the header), the
  payload, and a SHA-256 trailer. Rotation writes a snapshot and a new journal generation through a
  manifest, with six crash failpoints tested.
- **Damage rules.** The tail is cut automatically **only** when a verified header declares more
  bytes than remain (an interrupted append). A partial header (under 32 bytes) or any checksum
  mismatch fails with `STORAGE_CORRUPT` and needs an explicit operator truncate.
- **Locking.** An exclusive `LOCK` file. Takeover happens only when the holder is provably dead on
  the same host, boot and PID namespace, under a `LOCK.recovery` guard with nonce revalidation.
  There is no `breakLock` option. Where identity cannot be proven (Windows, macOS), a stale lock
  needs the documented manual recovery (`docs/guides/storage-recovery.md`), which removes the guard
  last. Amended in PR #3: the takeover writes `LOCK.new-*` and renames it over `LOCK`; a failed
  replacement backs out or keeps the guard, so ownership is conditional (R15.17 as amended;
  design 9.1 steps 5 and 6).
- **IndexedDB.** One object store `kv`, one IDB transaction per call with strict durability where
  supported, and a Web Lock per database so a second tab gets `STORAGE_LOCKED`.

## Consequences

- One conformance suite runs against all three adapters (and in Chromium for IndexedDB).
- Kill tests with a real child process pass on every platform with that platform's behavior.
- Checksums detect accidental damage, not a malicious local user (threat model).
