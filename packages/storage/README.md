# @weave/storage

Storage adapters for WEAVE replicas. Each implements `StorageAdapter` from `@weave/core`: ordered
keys and atomic, durable transactions. All three pass the same conformance suite.

| Entry point                | Function                             | Runs in  |
| -------------------------- | ------------------------------------ | -------- |
| `@weave/storage/memory`    | `memoryStorage({ backing? })`        | anywhere |
| `@weave/storage/file`      | `fileStorage({ dir, rotateBytes? })` | Node.js  |
| `@weave/storage/indexeddb` | `indexedDbStorage({ name })`         | browsers |

```ts
import { createReplica } from '@weave/core';
import { fileStorage } from '@weave/storage/file';

const replica = await createReplica({ storage: fileStorage({ dir: './data' }), collections });
```

## Memory

For tests and the quick start. A `MemoryBacking` (`createMemoryBacking()`) holds committed data,
so several adapters can open it one after another to model a restart.

## File

An append-only journal per generation: every committed transaction is one record with a 32-byte
checked header and a SHA-256 trailer, fsynced before the transaction resolves. Snapshots and
journal rotation go through a `MANIFEST`. An interrupted final append is cut on open; any other
damage fails with `STORAGE_CORRUPT` and changes nothing.

One writer per directory, through a `LOCK` file. A dead holder's lock is taken over only when that
can be proven (Linux with a readable `/proc`); otherwise the open fails with `STORAGE_LOCKED` and
[the manual recovery guide](../../docs/guides/storage-recovery.md) applies.

## IndexedDB

One object store `kv`, one IndexedDB transaction per call, and a Web Lock per database, so a
second tab on the same database gets `STORAGE_LOCKED`. Tested in Chromium (`npm run test:browser`).

## Writing your own

See [the custom storage guide](../../docs/guides/custom-storage.md) and run `runStorageConformance`
from `@weave/testing`. Design notes: [ADR-0009](../../docs/adr/0009-storage-and-journal.md).
