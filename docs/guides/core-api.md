# Core API

The essentials of `@weave/core` with the adapters and transports. Every example on this page is
type-checked and run against the current code. The generated reference (`npm run docs:api`) lists
every export with its documentation.

## Define a collection

A collection has a name, a schema version and typed fields. Each field has a merge rule for
concurrent edits.

```ts
import { createReplica, defineCollection, f } from '@weave/core';

export const tasks = defineCollection({
  name: 'tasks',
  version: 1,
  fields: {
    title: f.string({ required: true }), // last writer wins
    priority: f.number({ resolver: 'max' }), // the higher value wins
    tags: f.set(f.string()), // union: no tag is lost
    state: f.rank(['todo', 'doing', 'done'], { required: true }), // the most advanced wins
  },
});
```

Field builders: `f.string`, `f.number`, `f.boolean`, `f.json`, `f.set`, `f.rank`, and the opt-in
`f.counter` and `f.custom` ([resolver guide](custom-resolver.md)). When fields change, raise
`version` and add a migration ([migrations guide](migrations.md)).

## Create a replica

A replica is one device's copy of the data. It needs a storage adapter and the collections it
uses.

```ts
import { fileStorage } from '@weave/storage/file'; // Node.js
// import { indexedDbStorage } from '@weave/storage/indexeddb';  // browsers
// import { memoryStorage } from '@weave/storage/memory';        // tests

const replica = await createReplica({
  storage: fileStorage({ dir: './data' }),
  collections: [tasks],
});
```

Optional settings include `logger`, and for tests `clock`, `random` and `scheduler`. The opt-in
0.2.0 settings `compaction`, `holdNewerSchema`, `authorize` and `ban` are described in
[ADR-0015](../adr/0015-phase-5-contract-additions.md). Call `await replica.close()` when you are
done; a file-backed replica holds a lock on its directory until then.

## Write, with a `mutationId`

Every `create`, `update`, `delete` (and opt-in `restore`) needs a `mutationId`: one stable ID per
user intent. Create it once, store it with the intent before the first attempt, and reuse it on
every retry. A retry with the same ID returns the original result (`replayed: true`) and creates no
second change.

```ts
const col = replica.collection(tasks);

const mutationId = replica.newMutationId(); // save this with the pending action
const { recordId } = await col.create({ title: 'Check the pump', state: 'todo' }, { mutationId });

await col.update(recordId, { state: 'doing', tags: ['urgent'] }, { mutationId: replica.newMutationId() });
```

Never generate a fresh ID inside a retry loop. Reusing one ID for a different change fails with
`MUTATION_ID_REUSED`. Values are checked against the field types: `required` means the field
must be present, so an empty string is still a valid `f.string`.

## Read

```ts
const one = await col.get(recordId); // { id, value, conflicts }, or undefined
const open = await col.query({ where: { state: 'doing' }, orderBy: 'title', direction: 'asc' });
const ops = await col.history(recordId); // the record's operations, oldest first, as written
```

`query` takes `where` (field equality), `orderBy`, `direction` and `includeDeleted`.
`replica.subscribe(listener)` calls `listener` after every local or synced change and returns an
unsubscribe function.

## Sync

`replica.sync(endpoint)` exchanges changes with any `SyncEndpoint`:

```ts
import { httpTransport } from '@weave/transport/http';

const result = await replica.sync(httpTransport({ baseUrl: 'http://127.0.0.1:8787' }));
if (result.status === 'complete') {
  // both sides were verified to hold the same changes
} else if (result.status === 'partial') {
  // result.code is 'PEER_SCHEMA_OLDER' (a schema version is missing) or 'NOT_SETTLED'
} else {
  // 'failed': result.code says why; nothing local was lost
}
```

Endpoints: a relay over HTTP (`@weave/transport/http`), another replica in the same process
(`otherReplica.endpoint()`, optionally wrapped in `inProcessTransport`), or another device over
WebSocket (`@weave/transport/websocket`, see the [transport README](../../packages/transport/README.md)).
Retryable network errors are retried with backoff. `sync` accepts `{ maxRounds, batchSize }`.

## Status, hashes and conflicts

```ts
const status = await replica.status(); // vector, pendingBuffer, peers (pendingOps, lastResult, lastSyncWall), ...
const hashes = await replica.hashes(); // equal on replicas that hold the same changes
const current = await replica.conflicts.current(); // conflicts still in effect
const all = await replica.conflicts.history(); // including ones a later edit superseded
```

A conflict record names the collection, record and field, the competing values (`frontier`) and
the resolved value. The demo apps build their notices and conflict views from these two calls.

## Errors

Failures throw `WeaveError` with a stable `code` (for example `VALIDATION_FAILED`,
`MUTATION_ID_REUSED`, `SCHEMA_TOO_NEW`, `STORAGE_LOCKED`, `TRANSPORT_ERROR`). Use
`isWeaveError(e)` to test for one; `e.retryable` is `true` only for transport errors that are worth
retrying. The full list is `ERROR_CODES`.

```ts
import { isWeaveError } from '@weave/core';

try {
  // 'archived' is not one of the state field's ranks
  await col.update(recordId, { state: 'archived' as 'done' }, { mutationId: replica.newMutationId() });
} catch (e) {
  if (isWeaveError(e) && e.code === 'VALIDATION_FAILED') console.log('not a valid state');
}

await replica.close();
```

## Opt-in features (0.2.0)

| Feature                     | Entry point                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| Compaction, `removePeer`    | `createReplica({ compaction })`, `replica.compact()`, `replica.removePeer(id)` |
| Snapshots                   | `replica.exportSnapshot()`, `replica.bootstrap(snapshotOrEndpoint)`          |
| Restore, `update-wins`      | `defineCollection({ deletes })`, `collection.restore(id, { mutationId })`    |
| Counter and custom fields   | `f.counter()`, `f.custom(base, defineResolver(name, fn))`                   |
| Holding newer-schema ops    | `createReplica({ holdNewerSchema: true })`, `status().held`                  |
| Authorization and identity  | `createReplica({ authorize })`, `replica.endpoint({ auth })`, relay `identities` |
| Peer bans                   | `createReplica({ ban })`, `status().bans`                                    |

Each is described with its limits in [ADR-0015](../adr/0015-phase-5-contract-additions.md).
