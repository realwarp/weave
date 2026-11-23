# WEAVE

An offline-first application foundation.

Independent devices and records → exchanged changes → reconciled shared state.

WEAVE is a reusable TypeScript library for building offline-first applications. Devices keep working with no connection, record changes independently, exchange those changes later, and end up with the same shared state.

## Install

- Node.js 22+
- `npm ci`
- `npm run build`
- `npm test`

## Quick start

```ts
import { createReplica, defineCollection, f } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';

// Define a collection schema
const requests = defineCollection({
  name: 'requests',
  version: 1,
  fields: {
    title:     f.string({ required: true }),
    details:   f.string(),
    tags:      f.set(f.string()),
    claimedBy: f.string({ resolver: 'last-writer-wins' }),
    state:     f.rank(['open', 'fulfilled'], { required: true }),
  },
});

// Create a replica with in-memory storage
const replica = await createReplica({
  storage: memoryStorage('my-replica'),
  collections: [requests],
});

// Write a record
const mutationId = replica.newMutationId();
await replica.collection(requests).create(
  { title: 'Fix leak', details: 'Kitchen sink', tags: ['urgent'], state: 'open' },
  { mutationId }
);

// Sync with another replica
const b = await createReplica({
  storage: memoryStorage('another-replica'),
  collections: [requests],
});

await b.sync(a.endpoint());

// Read the record
const record = await b.collection(requests).get(mutationId);
console.log(record?.data);
// { title: 'Fix leak', details: 'Kitchen sink', tags: ['urgent'], state: 'open' }

// Get hashes for verification
const hashes = await replica.hashes();
console.log(hashes);
// { state: 'abc...', 'opSet': 'def...', 'conflictView': 'ghi...' }
```

## Architecture

- **Operation log:** Every write becomes one immutable, hash-protected op.
- **State derivation:** State is computed purely from the accepted op set.
- **Version vectors:** Replicas exchange ops using version vectors.
- **Pure resolvers:** Concurrent edits are merged by deterministic rules.
- **Adapters:** Storage and transport are pluggable.

See `docs/architecture.md` for a longer overview and `docs/adr/` for design decisions.

## Packages

| Package | Description |
|---|---|
| `@weave/core` | Engine, schema, resolvers, canonical codec, sync engine |
| `@weave/storage` | Memory, file, IndexedDB adapters |
| `@weave/transport` | In-process and HTTP transports |
| `@weave/relay` | Store-and-forward relay server |
| `@weave/testing` | Conformance suites, simulators, generators (dev only) |

## Applications

- **GHOSTLINE:** Community coordination (announcements, requests, local information).
- **FIELDNOTE:** Field operations (inspection records, observations, concurrent edits).

Both are in progress.

## Status

### Implemented

- Core engine: ops, canonical encoding, hashing, schema definitions, resolvers, state derivation, replica open/write/read
- Storage adapters: memory, file (journal), IndexedDB
- Transport: in-process, HTTP client
- Sync engine: version vector exchange, batch transfer, retry, pending buffer, schema-aware delivery
- Testing tools: conformance suites, fault injection, generators

### Not yet implemented (MVP future work)

- Relay server
- Compaction
- Snapshot bootstrap
- Full GHOSTLINE app
- Full FIELDNOTE app

## Guides

- [Custom storage adapter](docs/guides/custom-storage.md)
- [Custom transport](docs/guides/custom-transport.md)
- [Custom resolvers](docs/guides/custom-resolver.md)
- [Migrations](docs/guides/migrations.md)

## License

MIT