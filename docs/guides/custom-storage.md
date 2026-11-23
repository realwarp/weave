# Custom storage adapter

WEAVE's storage layer is an adapter interface. You can implement a custom adapter to store ops and state in any backend that supports atomic transactions and key-value scans.

## StorageAdapter and StorageTx interfaces

```ts
interface StorageAdapter {
  open(): Promise<StorageTx>;
  close(): Promise<void>;
  name: string;
}

interface StorageTx {
  get(key: string): Promise<string | undefined>;
  getMany(keys: string[]): Promise<(string | undefined)[]>;
  scan(prefix: string): AsyncIterable<[string, string]>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

## Atomicity and durability

- Every write (`put`, `delete`) is buffered and only committed on `commit()`.
- `rollback()` discards all buffered changes since the last commit.
- A transaction must be atomic: either all changes persist or none do.
- On `commit()`, all writes must be durable before returning.

## Scan ordering

- `scan(prefix)` must return entries in ascending key order.
- For a given prefix, keys must be returned in byte-wise (UTF-8) order.
- The adapter may support multi-key scans by using a prefix that covers the desired range.

## Key layout

See `design.md` section 3.4 and `packages/core/src/contracts/storage.ts`:

| Key | Value | Purpose |
|---|---|---|
| `meta/replica` | `{replicaId}` | identity |
| `meta/state` | `{vector, maxLamport, commit}` | version vector and Lamport max |
| `meta/schema` | `{collection: version}` | schema version |
| `op/<origin>/<seq:12 digits>` | op line | the op log (accepted ops only) |
| `rop/<collection>/<recordId>/<origin>/<seq:12>` | `""` | per-record op index |
| `rec/<collection>/<recordId>` | `DerivedRecord` JSON | materialized state |
| `mut/<mutationId>` | `MutationRecord` JSON | idempotency key |
| `pend/<origin>/<seq:12>` | op line | pending buffer for sequence gaps |
| `peer/<peerId>` | `PeerEntry` | peer registry and acknowledgements |
| `notified/<conflictId>` | `""` | live-notification marks |

## Running the conformance suite

```ts
import { runStorageConformance } from '@weave/testing';
import { MyStorageAdapter } from './my-adapter';

const factory = () => new MyStorageAdapter('test-db');
runStorageConformance(factory);
```

The conformance suite checks:

- Atomicity (rollback discards writes)
- Durability (data survives reopen)
- Scan ordering and prefix filtering
- Snapshot reads (reads reflect the state at transaction start)
- Large batches
- Serialized transactions (concurrent transactions don't interleave)

## IndexedDB constraints

IndexedDB transactions must only `await` `tx` calls:

```ts
// Correct
await tx.store.put(record);

// Incorrect
await someOtherPromise();
await tx.store.put(record);
```

Enforced by ESLint in `packages/storage/src/indexeddb/**`.