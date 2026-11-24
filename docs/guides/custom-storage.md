# Custom storage adapter

A storage adapter gives WEAVE an ordered key-value store with atomic transactions. The contract is
in `packages/core/src/contracts/storage.ts`.

## The interface

```ts
interface StorageAdapter {
  open(): Promise<void>;
  close(): Promise<void>;
  transaction<T>(mode: 'ro' | 'rw', fn: (tx: StorageTx) => Promise<T>): Promise<T>;
}

interface StorageTx {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): void;
  delete(key: string): void;
  scan(prefix: string, options?: { after?: string; limit?: number }): Promise<Array<[string, string]>>;
}
```

## Rules

- A `rw` transaction is atomic: when `fn` throws, nothing is written. When `transaction`
  resolves, every write is durable.
- Transactions are serialized. A transaction sees its own writes and a stable snapshot of the
  rest.
- Keys are ASCII. `scan` returns keys that start with `prefix`, in ascending byte order, strictly
  after `after` when it is given, and at most `limit` entries.
- `fn` may only await calls on `tx`. IndexedDB closes a transaction that waits on anything else.
- A second `open` of storage that is already open elsewhere fails with `STORAGE_LOCKED`.

The engine owns the key layout (`keys` in the contract file). An adapter never interprets values.

## Conformance

`@weave/testing` runs the same suite that the built-in adapters pass:

```ts
import { runStorageConformance } from '@weave/testing';

runStorageConformance('my adapter', async () => {
  const adapter = createMyAdapter({ path: freshPath() });
  return { adapter, reopen: async () => createMyAdapter({ path: samePath }) };
});
```

It covers atomicity (including aborted transactions), durability across reopen, scan order and
prefixes, snapshot reads, large batches and concurrent transaction serialization.
